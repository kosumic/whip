import { Pencil, Unplug, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { APP_FROSTED_GLASS_SURFACE_PROPS } from '../lib/appGlass';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import { useTheme } from '../theme';
import { hapticPress } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Button, type ButtonProps } from './ui/button';
import { Text } from './ui/text';

export const RailAction = {
  Rename: 'rename',
  Close: 'close',
  Disconnect: 'disconnect',
} as const;
export type RailAction = (typeof RailAction)[keyof typeof RailAction];

const ACTION_APPEARANCE = {
  [RailAction.Rename]: { label: 'rail.rename', icon: Pencil },
  [RailAction.Close]: { label: 'common.close', icon: X },
  [RailAction.Disconnect]: { label: 'rail.disconnect', icon: Unplug },
} as const;
const OPEN_MENU_ACTION = 'rail-menu';
const EMPTY_ACTIONS: readonly RailItemAction[] = [];

export interface RailItemAction {
  id: RailAction;
  accessibilityLabel: string;
  onPress: () => unknown;
}

type Props = Omit<ButtonProps, 'onPress' | 'onPressIn' | 'onLongPress' | 'accessibilityActions' | 'onAccessibilityAction'> & {
  label: string;
  actions?: readonly RailItemAction[];
  actionsDisabled?: boolean;
  onPress: () => unknown;
};

export function RailItemButton({ label, actions = EMPTY_ACTIONS, actionsDisabled = false, onPress, disabled, children, ...props }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuOpenRef = useRef(false);
  const mounted = useRef(false);
  const pendingAction = useRef<string | null>(null);
  const longPressed = useRef(false);
  const canOpen = !disabled && !actionsDisabled && actions.length > 0;
  const current = useRef({ actions, canOpen });
  current.current = { actions, canOpen };

  const closeMenu = () => {
    pendingAction.current = null;
    menuOpenRef.current = false;
    setMenuOpen(false);
  };
  const openMenu = () => {
    if (!mounted.current || !current.current.canOpen || pendingAction.current) return;
    menuOpenRef.current = true;
    setMenuOpen(true);
  };
  const runAction = (id: string, fromMenu = false) => {
    if (!mounted.current || !current.current.canOpen || pendingAction.current || (fromMenu && !menuOpenRef.current)) return;
    const action = current.current.actions.find(item => item.id === id);
    if (!action) return;
    const waitForDismissal = menuOpenRef.current && Platform.OS === 'ios';
    closeMenu();
    // iOS must dismiss this native modal before Rename can present its editor.
    if (waitForDismissal) {
      pendingAction.current = id;
      return;
    }
    return action.onPress();
  };
  const finishDismissal = () => {
    const id = pendingAction.current;
    pendingAction.current = null;
    if (id) reportBackgroundFailure(Promise.resolve().then(() => runAction(id)), 'rail-menu-action');
  };

  useEffect(() => {
    if (!canOpen) {
      pendingAction.current = null;
      menuOpenRef.current = false;
      setMenuOpen(false);
    }
  }, [canOpen]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      menuOpenRef.current = false;
      pendingAction.current = null;
    };
  }, []);

  return (
    <>
      <Button
        {...props}
        disabled={disabled}
        accessibilityHint={canOpen ? t('rail.actionsHint') : undefined}
        accessibilityActions={canOpen ? [
          { name: OPEN_MENU_ACTION, label: t('rail.actions') },
          ...actions.map(action => ({ name: action.id, label: action.accessibilityLabel })),
        ] : undefined}
        onAccessibilityAction={event => {
          const id = event.nativeEvent.actionName;
          hapticPress(() => id === OPEN_MENU_ACTION ? openMenu() : runAction(id))();
        }}
        onPressIn={() => { longPressed.current = false; }}
        onPress={hapticPress(() => {
          if (disabled || longPressed.current) return;
          return onPress();
        })}
        onLongPress={canOpen ? hapticPress(() => {
          longPressed.current = true;
          openMenu();
        }) : undefined}
      >
        {children}
      </Button>
      {actions.length > 0 && (
        <Modal animationType="fade" onRequestClose={closeMenu} onDismiss={finishDismissal} statusBarTranslucent transparent visible={menuOpen && canOpen}>
          <View className="flex-1 items-center justify-center px-5">
            <Pressable accessibilityLabel={t('common.cancel')} className="absolute inset-0 bg-black/55" onPress={hapticPress(closeMenu)} />
            <GlassSurface {...APP_FROSTED_GLASS_SURFACE_PROPS} accessibilityViewIsModal className="w-full max-w-[380px] rounded-[24px] border border-white/30 p-4 dark:border-white/10">
              <Text accessibilityRole="header" numberOfLines={2} className="mb-3 px-2 text-[17px] font-semibold">{label}</Text>
              {actions.map(action => {
                const appearance = ACTION_APPEARANCE[action.id];
                const ActionIcon = appearance.icon;
                const destructive = action.id !== RailAction.Rename;
                return (
                  <Button key={action.id} accessibilityLabel={action.accessibilityLabel} className="h-12 justify-start rounded-xl px-3" variant="ghost" onPress={hapticPress(() => runAction(action.id, true))}>
                    <ActionIcon size={18} color={destructive ? colors.error : colors.text} />
                    <Text className={destructive ? 'text-destructive' : undefined}>{t(appearance.label)}</Text>
                  </Button>
                );
              })}
              <Button className="mt-3 rounded-full" variant="secondary" onPress={hapticPress(closeMenu)}>
                <Text>{t('common.cancel')}</Text>
              </Button>
            </GlassSurface>
          </View>
        </Modal>
      )}
    </>
  );
}
