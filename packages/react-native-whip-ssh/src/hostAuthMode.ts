import { HostAuthMode } from './generated/whip_ssh';

export type AuthMode = 'password' | 'key' | 'none';

export function toNativeHostAuthMode(mode: AuthMode): HostAuthMode {
  switch (mode) {
    case 'password': return HostAuthMode.Password;
    case 'key': return HostAuthMode.Key;
    case 'none': return HostAuthMode.None;
  }
}

export function fromNativeHostAuthMode(mode: HostAuthMode): AuthMode {
  switch (mode) {
    case HostAuthMode.Password: return 'password';
    case HostAuthMode.Key: return 'key';
    case HostAuthMode.None: return 'none';
  }
}
