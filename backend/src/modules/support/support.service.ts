import type { SupportTicketCategory, SupportTicketStatus } from '@prisma/client';
import { prisma } from '../../config/db';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { recordAdminChange } from '../admin/adminAudit';
import {
  MAX_OPEN_TICKETS_PER_USER, OPEN_STATUSES, canAdminReply, canUserReply, isStatusChange, resolvedAtAfter,
  statusAfterAdminReply, statusAfterUserReply,
} from './support.rules';

const author = { select: { id: true, username: true, displayName: true } } as const;
const requester = { select: { id: true, username: true, displayName: true } } as const;

/** Vue d'un ticket côté utilisateur : ses propres messages, sans rien d'interne. */
const userView = {
  id: true, subject: true, category: true, status: true, lastMessageAt: true, resolvedAt: true, createdAt: true,
  messages: { orderBy: { createdAt: 'asc' as const }, select: { id: true, authorRole: true, body: true, createdAt: true } },
} as const;

/** Vue d'un ticket côté équipe : demandeur, administrateur assigné et auteurs des messages. */
const adminView = {
  id: true, userId: true, subject: true, category: true, status: true, assignedAdminId: true,
  lastMessageAt: true, resolvedAt: true, createdAt: true, updatedAt: true,
  user: requester,
  messages: { orderBy: { createdAt: 'asc' as const }, select: { id: true, authorRole: true, body: true, createdAt: true, author } },
} as const;

async function ownedTicket(userId: string, id: string) {
  const ticket = await prisma.supportTicket.findFirst({ where: { id, userId } });
  if (!ticket) throw notFound('Ticket introuvable');
  return ticket;
}

// ── Utilisateur ─────────────────────────────────────────────────────

export async function openTicket(userId: string, input: { subject: string; category: SupportTicketCategory; body: string }) {
  const inProgress = await prisma.supportTicket.count({ where: { userId, status: { in: [...OPEN_STATUSES] } } });
  if (inProgress >= MAX_OPEN_TICKETS_PER_USER) {
    throw conflict('SUPPORT_TOO_MANY_OPEN', 'Vous avez déjà plusieurs demandes en cours. Attendez une réponse avant d’en ouvrir une nouvelle.');
  }
  const now = new Date();
  return prisma.supportTicket.create({
    data: {
      userId, subject: input.subject, category: input.category, status: 'OPEN', lastMessageAt: now,
      messages: { create: { authorId: userId, authorRole: 'USER', body: input.body } },
    },
    select: userView,
  });
}

export async function listOwnTickets(userId: string) {
  return prisma.supportTicket.findMany({
    where: { userId }, orderBy: { lastMessageAt: 'desc' }, take: 50,
    select: { id: true, subject: true, category: true, status: true, lastMessageAt: true, createdAt: true },
  });
}

export async function getOwnTicket(userId: string, id: string) {
  await ownedTicket(userId, id);
  return prisma.supportTicket.findUniqueOrThrow({ where: { id }, select: userView });
}

export async function replyAsUser(userId: string, id: string, body: string) {
  const ticket = await ownedTicket(userId, id);
  if (!canUserReply(ticket.status)) throw conflict('SUPPORT_TICKET_CLOSED', 'Ce ticket est clos.');
  const now = new Date();
  const next = statusAfterUserReply(ticket.status);
  await prisma.$transaction([
    prisma.supportMessage.create({ data: { ticketId: id, authorId: userId, authorRole: 'USER', body } }),
    prisma.supportTicket.update({
      where: { id },
      data: { status: next, lastMessageAt: now, resolvedAt: next === 'OPEN' ? null : ticket.resolvedAt },
    }),
  ]);
  return prisma.supportTicket.findUniqueOrThrow({ where: { id }, select: userView });
}

// ── Équipe (dashboard admin) ────────────────────────────────────────

export async function listTickets(filter: { status?: SupportTicketStatus; category?: SupportTicketCategory; limit: number }) {
  return prisma.supportTicket.findMany({
    where: { ...(filter.status ? { status: filter.status } : {}), ...(filter.category ? { category: filter.category } : {}) },
    orderBy: { lastMessageAt: 'desc' }, take: filter.limit,
    select: { id: true, subject: true, category: true, status: true, assignedAdminId: true, lastMessageAt: true, resolvedAt: true, createdAt: true, user: requester },
  });
}

export async function getTicket(id: string) {
  const ticket = await prisma.supportTicket.findUnique({ where: { id }, select: adminView });
  if (!ticket) throw notFound('Ticket introuvable');
  return ticket;
}

export async function adminReply(adminId: string, id: string, body: string) {
  const ticket = await prisma.supportTicket.findUnique({ where: { id } });
  if (!ticket) throw notFound('Ticket introuvable');
  if (!canAdminReply(ticket.status)) throw conflict('SUPPORT_TICKET_CLOSED', 'Ce ticket est clos : rouvrez-le avant de répondre.');
  const now = new Date();
  await prisma.$transaction([
    prisma.supportMessage.create({ data: { ticketId: id, authorId: adminId, authorRole: 'ADMIN', body } }),
    prisma.supportTicket.update({
      where: { id },
      data: { status: statusAfterAdminReply(), lastMessageAt: now, resolvedAt: null, assignedAdminId: ticket.assignedAdminId ?? adminId },
    }),
  ]);
  // Le contenu du message n'est pas journalisé : seule l'action l'est.
  await recordAdminChange({
    adminId, action: 'REPLY support ticket', targetType: 'SUPPORT_TICKET', targetId: id, module: 'support',
    oldValue: { status: ticket.status }, newValue: { status: statusAfterAdminReply() },
  });
  return getTicket(id);
}

export async function setTicketStatus(adminId: string, id: string, to: SupportTicketStatus, reason: string) {
  const ticket = await prisma.supportTicket.findUnique({ where: { id } });
  if (!ticket) throw notFound('Ticket introuvable');
  if (!isStatusChange(ticket.status, to)) throw badRequest('SUPPORT_STATUS_UNCHANGED', 'Le ticket a déjà ce statut.');
  const now = new Date();
  await prisma.supportTicket.update({
    where: { id },
    data: {
      status: to, resolvedAt: resolvedAtAfter(ticket.status, ticket.resolvedAt, to, now),
      assignedAdminId: ticket.assignedAdminId ?? adminId,
    },
  });
  await recordAdminChange({
    adminId, action: 'PATCH support ticket status', targetType: 'SUPPORT_TICKET', targetId: id, reason, module: 'support',
    oldValue: { status: ticket.status }, newValue: { status: to },
  });
  return getTicket(id);
}
