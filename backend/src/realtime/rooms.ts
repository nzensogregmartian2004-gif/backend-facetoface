/**
 * Registre des salles de diffusion (une salle = un Live). Logique pure : aucune dépendance réseau, testable seule.
 * Un seul serveur pour l'instant : au-delà d'une instance, la diffusion passera par Redis pub/sub (hors étape 2).
 */
export class RoomRegistry<C extends { id: number }> {
  private readonly members = new Map<string, Map<number, C>>(); // salle -> (id connexion -> connexion)
  private readonly joined = new Map<number, Set<string>>();     // id connexion -> salles

  /** Ajoute une connexion à une salle. Renvoie false si elle y était déjà. */
  join(client: C, roomId: string): boolean {
    let room = this.members.get(roomId);
    if (!room) { room = new Map(); this.members.set(roomId, room); }
    if (room.has(client.id)) return false;
    room.set(client.id, client);
    let rooms = this.joined.get(client.id);
    if (!rooms) { rooms = new Set(); this.joined.set(client.id, rooms); }
    rooms.add(roomId);
    return true;
  }

  /** Retire une connexion d'une salle. Renvoie false si elle n'y était pas. */
  leave(client: C, roomId: string): boolean {
    const room = this.members.get(roomId);
    if (!room || !room.delete(client.id)) return false;
    if (room.size === 0) this.members.delete(roomId);
    const rooms = this.joined.get(client.id);
    if (rooms) { rooms.delete(roomId); if (rooms.size === 0) this.joined.delete(client.id); }
    return true;
  }

  isMember(client: C, roomId: string): boolean {
    return this.members.get(roomId)?.has(client.id) ?? false;
  }

  size(roomId: string): number {
    return this.members.get(roomId)?.size ?? 0;
  }

  /** À appeler à la fermeture d'une connexion : la retire de toutes ses salles. */
  unregister(client: C): void {
    const rooms = this.joined.get(client.id);
    if (!rooms) return;
    for (const roomId of [...rooms]) this.leave(client, roomId);
  }

  /** Envoie à chaque membre, via l'écrivain fourni. Une erreur chez un membre n'empêche pas les autres. Renvoie le nombre de réussites. */
  publish(roomId: string, write: (client: C) => void): number {
    const room = this.members.get(roomId);
    if (!room) return 0;
    let delivered = 0;
    for (const client of [...room.values()]) {
      try { write(client); delivered++; } catch { /* connexion morte : nettoyée à sa fermeture */ }
    }
    return delivered;
  }

  /** Ferme une salle (fin du Live) : retire tous ses membres. Renvoie leur nombre. */
  close(roomId: string): number {
    const room = this.members.get(roomId);
    if (!room) return 0;
    const clients = [...room.values()];
    for (const client of clients) this.leave(client, roomId);
    return clients.length;
  }
}

/** Limiteur à fenêtre glissante, par connexion : au plus `max` actions dans `windowMs` millisecondes. */
export class WindowLimiter {
  private hits: number[] = [];
  constructor(private readonly max: number, private readonly windowMs: number) {}

  allow(now: number): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}
