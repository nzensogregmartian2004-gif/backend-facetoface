import { describe, expect, it } from 'vitest';
import { subscribeSchema, settingsSchema, promotionSchema } from './premium.schemas';

describe('premium schemas',()=>{
 it('accepte mensuel/annuel et mobile money',()=>expect(subscribeSchema.parse({billingPeriod:'MONTHLY',operator:'AIRTEL_MONEY',phone:'+237 690000000'}).billingPeriod).toBe('MONTHLY'));
 it('normalise les promotions',()=>expect(promotionSchema.parse({code:'rentree',type:'PERCENT',value:2000,startsAt:'2026-10-01',endsAt:'2026-11-01'}).code).toBe('RENTREE'));
 it('rejette un prix Premium négatif',()=>expect(()=>settingsSchema.parse({monthlyPriceMinor:-1})).toThrow());
});
