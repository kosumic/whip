import { useMemo, useState } from 'react';
import { tailcatServerCommand } from 'react-native-whip-ssh';
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react-native';
import { Alert, Linking, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { hapticPress } from './app-ui';
import { NativeCodeBlock } from './NativeCodeBlock';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Switch } from './ui/switch';
import { Text } from './ui/text';

const TAILCAT_INSTALL_URL = 'https://github.com/tailscale/tailcat/blob/main/INSTALL.md';
const TAILCAT_SERVER_KEY = 'whip';
const CREATE_SERVER_KEY_COMMAND = `tailcat genkey --key=${TAILCAT_SERVER_KEY} --fixed-region`;
const DEFAULT_SSH_PORT = 22;
const MAX_PORT = 65535;

interface Props {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  port?: string;
  sshServer?: boolean;
  onSshServerChange?: (enabled: boolean) => void;
  clientPublicKey?: string;
  sshPublicKey?: string;
  identityError?: boolean;
  identityPending?: boolean;
  onRetryIdentity?: () => void;
}

function TailcatCommand({ title, command, language = 'bash' }: { title: string; command: string; language?: string }) {
  return (
    <View className="gap-2">
      <Text className="text-xs font-medium">{title}</Text>
      <NativeCodeBlock content={command} language={language} />
    </View>
  );
}

export function TailcatSettings({ enabled, onEnabledChange, port, sshServer, onSshServerChange, clientPublicKey, sshPublicKey, identityError, identityPending, onRetryIdentity }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const parsedPort = Number(port);
  const sshPort = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= MAX_PORT
    ? parsedPort : DEFAULT_SSH_PORT;
  const { serverCommand, allowlistCommand } = useMemo(() => {
    const command = (nodeKey?: string) => {
      try {
        return tailcatServerCommand(nodeKey, sshPort, Boolean(sshServer), sshPublicKey);
      } catch {
        return undefined;
      }
    };
    return {
      serverCommand: command(),
      allowlistCommand: clientPublicKey ? command(clientPublicKey) : undefined,
    };
  }, [clientPublicKey, sshPort, sshServer, sshPublicKey]);
  return (
    <View className="mb-3.5">
      <View className="min-h-[72px] flex-row items-center gap-4">
        <View className="flex-1">
          <Text className="text-[15px] font-semibold leading-5">{t('connection.tailcat')}</Text>
          <Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">
            {t('connection.tailcatCopy')}
          </Text>
        </View>
        <Switch
          accessibilityLabel={t('connection.tailcat')}
          checked={enabled}
          onCheckedChange={onEnabledChange}
        />
      </View>
      {enabled && onSshServerChange ? (
        <View className="min-h-[72px] flex-row items-center gap-4">
          <View className="flex-1">
            <Text className="text-[15px] font-semibold leading-5">{t('connection.tailcatSshServer')}</Text>
            <Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">{t('connection.tailcatSshServerCopy')}</Text>
          </View>
          <Switch accessibilityLabel={t('connection.tailcatSshServer')} checked={Boolean(sshServer)} onCheckedChange={onSshServerChange} />
        </View>
      ) : null}
      {enabled ? (
        <View className="mb-3 gap-2">
          {clientPublicKey ? (
            <TailcatCommand title={t('connection.tailcatClientIdentity')} command={clientPublicKey} language="text" />
          ) : (
            <Text className="text-xs leading-5 text-muted-foreground">{t(identityError ? 'connection.tailcatIdentityError' : identityPending ? 'connection.tailcatIdentityCreating' : 'connection.tailcatIdentityInEditor')}</Text>
          )}
          {identityError && onRetryIdentity ? <Button variant="ghost" onPress={hapticPress(onRetryIdentity)}><Text>{t('connection.tailcatIdentityRetry')}</Text></Button> : null}
        </View>
      ) : null}
      <Button
        accessibilityLabel={t('connection.tailcatHelp')}
        accessibilityState={{ expanded }}
        variant="ghost"
        className="justify-between px-0"
        onPress={hapticPress(() => setExpanded(value => !value))}>
        <Text className="flex-1">{t('connection.tailcatHelp')}</Text>
        <Icon as={expanded ? ChevronUp : ChevronDown} size={17} className="text-muted-foreground" />
      </Button>
      {expanded ? (
        <View className="gap-4 border-t border-border py-3">
          <Text className="text-xs leading-5 text-muted-foreground">{t('connection.tailcatHowItWorks')}</Text>
          <Text className="text-xs leading-5 text-muted-foreground">{t('connection.tailcatRouting')}</Text>
          <View className="gap-1.5">
            <Button
              accessibilityRole="link"
              accessibilityLabel={t('connection.tailcatSource')}
              className="h-9 self-start px-0"
              variant="link"
              onPress={hapticPress(() => {
                Linking.openURL(TAILCAT_INSTALL_URL).catch(error => {
                  Alert.alert(t('about.githubError'), String(error));
                });
              })}>
              <Icon as={ExternalLink} size={15} className="text-primary" />
              <Text>{t('connection.tailcatSource')}</Text>
            </Button>
            <Text className="text-xs leading-5 text-muted-foreground">{t(sshServer ? 'connection.tailcatBuiltinInstall' : 'connection.tailcatInstall')}</Text>
          </View>
          <TailcatCommand title={t('connection.tailcatCreateIdentity')} command={CREATE_SERVER_KEY_COMMAND} />
          {serverCommand ? <TailcatCommand title={t('connection.tailcatStartServer')} command={serverCommand} /> : (
            <Text className="text-xs leading-5 text-muted-foreground">{t(sshServer ? 'connection.tailcatSshKeyRequired' : 'connection.tailcatIdentityInEditor')}</Text>
          )}
          <Text className="text-xs leading-5 text-muted-foreground">{t(sshServer ? 'connection.tailcatBuiltinConnect' : 'connection.tailcatConnect')}</Text>
          <View className="gap-1.5">
            <Text className="text-xs font-medium">{t('connection.tailcatAllowlist')}</Text>
            <Text className="text-xs leading-5 text-muted-foreground">{t('connection.tailcatAllowlistCopy')}</Text>
            {allowlistCommand ? (
              <TailcatCommand
                title={t('connection.tailcatAllowlistRestart')}
                command={allowlistCommand}
              />
            ) : <Text className="text-xs leading-5 text-muted-foreground">{t(clientPublicKey && sshServer ? 'connection.tailcatSshKeyRequired' : 'connection.tailcatIdentityInEditor')}</Text>}
          </View>
        </View>
      ) : null}
    </View>
  );
}
