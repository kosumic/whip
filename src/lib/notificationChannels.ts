// Local alerts and relay pushes share one notification thread.
export const AGENT_NOTIFICATION_THREAD_ID = 'whip-agent-chats';

// The relay and mobile app must agree on the Android push channel. A new ID is
// required because Android preserves an existing channel's importance.
export const AGENT_PUSH_CHANNEL_ID = 'agent-state-regular-v2';
export const AGENT_BANNER_CHANNEL_ID = 'agent-state-banner-v1';
