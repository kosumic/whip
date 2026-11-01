import {HostHerdrBackend} from './generated/whip_ssh';

export type HerdrBackend = 'auto' | 'legacy' | 'core';
export function toNativeHerdrBackend(value: HerdrBackend = 'legacy'): HostHerdrBackend {
  return value === 'core' ? HostHerdrBackend.Core : value === 'auto' ? HostHerdrBackend.Auto : HostHerdrBackend.Legacy;
}
export function fromNativeHerdrBackend(value: HostHerdrBackend): HerdrBackend {
  return value === HostHerdrBackend.Core ? 'core' : value === HostHerdrBackend.Auto ? 'auto' : 'legacy';
}
