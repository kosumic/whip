import type { AuthMode, ConnectionProfile } from '../types';

export interface ConnectionCredentialDrafts {
  password: string;
  privateKey: string;
  keyPassphrase: string;
}

export interface ConnectionCredentialState {
  profile: ConnectionProfile;
  drafts: ConnectionCredentialDrafts;
}

type ConnectionCredentialAction =
  | { type: 'reset'; profile: ConnectionProfile }
  | {
      type: 'profile-changed';
      changes: Partial<Omit<ConnectionProfile, 'authMode' | 'secret' | 'passphrase'>>;
    }
  | { type: 'auth-mode-changed'; authMode: AuthMode }
  | {
      type: 'credential-changed';
      changes: Partial<Pick<ConnectionProfile, 'secret' | 'passphrase'>>;
    };

export function createConnectionCredentialState(
  profile: ConnectionProfile,
): ConnectionCredentialState {
  return { profile, drafts: credentialDraftsForProfile(profile) };
}

export function connectionCredentialReducer(
  state: ConnectionCredentialState,
  action: ConnectionCredentialAction,
): ConnectionCredentialState {
  switch (action.type) {
    case 'reset':
      return createConnectionCredentialState(action.profile);
    case 'profile-changed':
      return { ...state, profile: { ...state.profile, ...action.changes } };
    case 'auth-mode-changed':
      return switchCredentialAuthMode(state.profile, state.drafts, action.authMode);
    case 'credential-changed':
      return updateActiveCredential(
        state.profile,
        state.drafts,
        action.changes.secret ?? state.profile.secret,
        action.changes.passphrase ?? state.profile.passphrase,
      );
  }
}

export function credentialDraftsForProfile(
  profile: ConnectionProfile,
): ConnectionCredentialDrafts {
  return {
    password: profile.authMode === 'password' ? profile.secret : '',
    privateKey: profile.authMode === 'key' ? profile.secret : '',
    keyPassphrase: profile.authMode === 'key' ? profile.passphrase : '',
  };
}

export function updateActiveCredential(
  profile: ConnectionProfile,
  drafts: ConnectionCredentialDrafts,
  secret: string,
  passphrase = profile.passphrase,
): ConnectionCredentialState {
  if (profile.authMode === 'password') {
    return {
      profile: { ...profile, secret, passphrase: '' },
      drafts: { ...drafts, password: secret },
    };
  }
  return {
    profile: { ...profile, secret, passphrase },
    drafts: { ...drafts, privateKey: secret, keyPassphrase: passphrase },
  };
}

export function switchCredentialAuthMode(
  profile: ConnectionProfile,
  drafts: ConnectionCredentialDrafts,
  authMode: AuthMode,
): ConnectionCredentialState {
  const captured = updateActiveCredential(
    profile,
    drafts,
    profile.secret,
    profile.passphrase,
  ).drafts;
  return {
    profile: {
      ...profile,
      authMode,
      secret: authMode === 'password' ? captured.password : captured.privateKey,
      passphrase: authMode === 'key' ? captured.keyPassphrase : '',
      forwardAgent: authMode === 'key' && Boolean(profile.forwardAgent),
    },
    drafts: captured,
  };
}
