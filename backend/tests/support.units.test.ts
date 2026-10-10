import { describe, expect, it } from 'vitest';
import { permissionForAdminPath } from '../src/modules/admin/permissions';
import {
  MAX_OPEN_TICKETS_PER_USER, canAdminReply, canUserReply, isStatusChange, resolvedAtAfter, statusAfterAdminReply, statusAfterUserReply,
} from '../src/modules/support/support.rules';
import { adminTicketQuerySchema, createTicketSchema, replySchema, ticketStatusChangeSchema } from '../src/modules/support/support.schemas';

describe('transitions de l’assistance', () => {
  it('un utilisateur ne répond pas à un ticket clos', () => {
    expect(canUserReply('CLOSED')).toBe(false);
    expect(canUserReply('RESOLVED')).toBe(true);
  });
  it('une réponse utilisateur rouvre le ticket, sauf s’il est déjà en cours de traitement', () => {
    expect(statusAfterUserReply('WAITING_USER')).toBe('OPEN');
    expect(statusAfterUserReply('RESOLVED')).toBe('OPEN');
    expect(statusAfterUserReply('IN_PROGRESS')).toBe('IN_PROGRESS');
  });
  it('une réponse de l’équipe attend l’utilisateur, et refuse un ticket clos', () => {
    expect(statusAfterAdminReply()).toBe('WAITING_USER');
    expect(canAdminReply('CLOSED')).toBe(false);
    expect(canAdminReply('OPEN')).toBe(true);
  });
  it('un changement de statut doit changer réellement le statut', () => {
    expect(isStatusChange('OPEN', 'OPEN')).toBe(false);
    expect(isStatusChange('OPEN', 'RESOLVED')).toBe(true);
  });
  it('la date de résolution est posée à la résolution, conservée entre résolu et clos, retirée à la réouverture', () => {
    const now = new Date('2026-10-10T10:00:00Z');
    const earlier = new Date('2026-10-01T08:00:00Z');
    expect(resolvedAtAfter('OPEN', null, 'RESOLVED', now)).toEqual(now);
    expect(resolvedAtAfter('RESOLVED', earlier, 'CLOSED', now)).toEqual(earlier);
    expect(resolvedAtAfter('CLOSED', earlier, 'OPEN', now)).toBeNull();
    expect(resolvedAtAfter('OPEN', null, 'IN_PROGRESS', now)).toBeNull();
  });
  it('la limite de tickets en cours est de cinq par utilisateur', () => expect(MAX_OPEN_TICKETS_PER_USER).toBe(5));
});

describe('schémas de l’assistance', () => {
  it('un ticket reçoit la catégorie OTHER par défaut', () => {
    const parsed = createTicketSchema.parse({ subject: 'Retrait bloqué', body: 'Bonjour, mon retrait est bloqué.' });
    expect(parsed.category).toBe('OTHER');
  });
  it('un objet trop court ou un message vide sont refusés', () => {
    expect(createTicketSchema.safeParse({ subject: 'ab', body: 'Bonjour' }).success).toBe(false);
    expect(replySchema.safeParse({ body: '   ' }).success).toBe(false);
  });
  it('un message de plus de 2000 caractères est refusé', () => {
    expect(replySchema.safeParse({ body: 'x'.repeat(2001) }).success).toBe(false);
    expect(replySchema.safeParse({ body: 'x'.repeat(2000) }).success).toBe(true);
  });
  it('un changement de statut exige un motif', () => {
    expect(ticketStatusChangeSchema.safeParse({ status: 'RESOLVED' }).success).toBe(false);
    expect(ticketStatusChangeSchema.safeParse({ status: 'RESOLVED', reason: 'Problème réglé' }).success).toBe(true);
    expect(ticketStatusChangeSchema.safeParse({ status: 'INCONNU', reason: 'Motif suffisant' }).success).toBe(false);
  });
  it('les filtres de liste acceptent un statut connu et refusent les autres valeurs', () => {
    expect(adminTicketQuerySchema.parse({ status: 'WAITING_USER' }).limit).toBe(50);
    expect(adminTicketQuerySchema.safeParse({ status: 'PERDU' }).success).toBe(false);
  });
});

describe('permissions des routes support côté administration', () => {
  it('lire les tickets exige la consultation, sans rien modifier', () => {
    expect(permissionForAdminPath('GET', '/support/tickets')).toBe('support.tickets.view');
    expect(permissionForAdminPath('GET', '/support/tickets/abc')).toBe('support.tickets.view');
  });
  it('répondre exige la réponse aux utilisateurs', () => {
    expect(permissionForAdminPath('POST', '/support/tickets/abc/messages')).toBe('support.tickets.reply');
  });
  it('changer le statut exige la permission de statut, distincte de la réponse', () => {
    expect(permissionForAdminPath('PATCH', '/support/tickets/abc/status')).toBe('support.tickets.status');
  });
  it('une route support ne retombe jamais sur admin.access', () => {
    expect(permissionForAdminPath('DELETE', '/support/tickets/abc')).not.toBe('admin.access');
  });
});
