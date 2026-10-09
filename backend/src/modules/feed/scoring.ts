import { forYouScore, trendingScore, type RankInput, type Signals } from './ranking';

/**
 * Stratégie de classement remplaçable (étape 12). Les routes du feed et de la découverte ne dépendent que de cette
 * interface : brancher un autre algorithme se fait ici, sans toucher aux routes ni aux réponses.
 */
export interface ScoringStrategy {
  readonly name: string;
  /** Score « tendances » : popularité pondérée qui décroît avec l'âge. */
  trending(i: RankInput, now: Date): number;
  /** Score « Pour toi » : tendances + signaux personnels. */
  forYou(i: RankInput, now: Date, s: Signals): number;
}

export const defaultScoring: ScoringStrategy = { name: 'gravite-v1', trending: trendingScore, forYou: forYouScore };

let active: ScoringStrategy = defaultScoring;
export const activeScoring = (): ScoringStrategy => active;
/** Remplace la stratégie active (tests, ou future configuration). */
export function setScoring(strategy: ScoringStrategy) { active = strategy; }
export function resetScoring() { active = defaultScoring; }
