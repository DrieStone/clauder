import { useEffect, useState } from 'react';
import { isNotificationsEnabled, enableNotifications, disableNotifications, isSupported } from '../lib/notifications';

export function NotificationToggle() {
  const [enabled, setEnabled] = useState(() => isNotificationsEnabled());
  const [supported] = useState(() => isSupported());

  // Re-check on mount in case state changed elsewhere
  useEffect(() => {
    setEnabled(isNotificationsEnabled());
  }, []);

  if (!supported) return null;

  const handleToggle = async () => {
    if (enabled) {
      disableNotifications();
      setEnabled(false);
    } else {
      const ok = await enableNotifications();
      setEnabled(ok);
      if (!ok && typeof Notification !== 'undefined' && Notification.permission === 'denied') {
        alert('Notifications are blocked. Enable them in your browser site settings.');
      }
    }
  };

  return (
    <button
      onClick={handleToggle}
      className={`px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
        enabled
          ? 'bg-blue-600/30 hover:bg-blue-600/50 text-blue-200 border border-blue-600/50'
          : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
      }`}
      title={enabled ? 'Notifications on — click to disable' : 'Enable browser notifications'}
    >
      {enabled ? '🔔' : '🔕'}
    </button>
  );
}
