import { getConfigValue } from './config.service';

/** Commission d'un flux payant : valeur administrée (configuration), repli sur la variable d'environnement. */
export async function commissionBpsFor(key: string, envValue: number): Promise<number> {
  const v = await getConfigValue<number>(key, envValue);
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000 ? v : envValue;
}
