import { describe, expect, it } from 'vitest';
import { contentActionSchema, listQuerySchema, userStatusSchema, withdrawalStatusSchema } from './admin.schemas';

describe('admin schemas',()=>{
  it('parse les filtres utilisateurs',()=>expect(listQuerySchema.parse({page:'2',limit:'10',isCreator:'true'}).isCreator).toBe(true));
  it('parse correctement false sans transformer une chaîne arbitraire en true',()=>expect(listQuerySchema.parse({isCreator:'false'}).isCreator).toBe(false));
  it('rejette un isCreator invalide',()=>expect(()=>listQuerySchema.parse({isCreator:'nimportequoi'})).toThrow());
  it('refuse un statut utilisateur inconnu',()=>expect(()=>userStatusSchema.parse({status:'HACKED'})).toThrow());
  it('limite les actions contenu aux statuts autorisés',()=>expect(contentActionSchema.parse({status:'HIDDEN'}).status).toBe('HIDDEN'));
  it('valide les statuts de retrait',()=>expect(withdrawalStatusSchema.parse({status:'PROCESSING'}).status).toBe('PROCESSING'));
});
