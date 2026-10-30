import { Image } from 'nsh';
import info from '../assets/icons/info.svg';
import externalLink from '../assets/icons/external-link.svg';
import share from '../assets/icons/share-2.svg';
import chevronUp from '../assets/icons/chevron-up.svg';
import chevronDown from '../assets/icons/chevron-down.svg';
import chevronRight from '../assets/icons/chevron-right.svg';
import refresh from '../assets/icons/refresh-cw.svg';
import download from '../assets/icons/download.svg';
import scale from '../assets/icons/scale.svg';

const icons = { info, externalLink, share, chevronUp, chevronDown, chevronRight, refresh, download, scale };
export type IconName = keyof typeof icons;

export function Icon(props: { name: IconName; size: number; color: string }) {
  return <Image src={icons[props.name]} accessible={false} style={{ width: props.size, height: props.size,
    flexShrink: 0, objectFit: 'contain', tintColor: props.color, pointerEvents: 'none' }} />;
}
