import { describe, expect, it } from 'vitest';
import { categoryOf, isNotificationEnabled } from '../src/modules/notifications/notifyPrefs';

describe('notifications des appels planifiés', () => {
  it('sont rangées dans la catégorie appels, et se coupent avec elle', () => {
    for (const type of ['CALL_SCHEDULE_REQUESTED', 'CALL_SCHEDULE_ANSWERED', 'CALL_SCHEDULE_CANCELLED']) {
      expect(categoryOf(type)).toBe('calls');
      expect(isNotificationEnabled({ calls: false }, type)).toBe(false);
      expect(isNotificationEnabled({ messages: false }, type)).toBe(true);
    }
  });
});
