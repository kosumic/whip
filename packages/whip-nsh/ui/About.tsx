import { host, Image, mount, cleanup, effect, setColorScheme, signal, Text, View, type JSX, type ViewStyle } from 'nsh';
import { Button } from 'nsh/base';
import { WhipAbout } from 'whip/about';
import {
  GOVUE_REPOSITORY_URL, LATEST_RELEASE_API_URL, UPDATE_CHECK_TIMEOUT_MS,
  WHIP_INSTALL_URL, WHIP_LATEST_RELEASE_URL, WHIP_REPOSITORY_URL, X_PROFILE_URL,
} from '../../../src/lib/aboutLinks';
import { HERDR_WEBSITE_URL } from '../../../src/lib/herdr';
import fonts from '../../../assets/terminal-fonts/manifest.json';
import whip from '../assets/whip-mark.png';
import herdr from '../assets/herdr.svg';
import github from '../assets/github.svg';
import x from '../assets/x.svg';
import govue from '../assets/govue.png';
import qr from '../assets/whip-install-qr.png';
import { translations, type Environment } from './environment';
import { Icon, type IconName } from './Icons';

const CARD_RADIUS = 16; // Whip's --radius: 1rem, with NativeWind inlineRem: 16.
const CONTROL_RADIUS = CARD_RADIUS - 4;
const ICON_SIZE = 44;
const SHARE_WIDTH = 56;
// The typographic family in Whip's Inter assets. iOS already registers these
// through Expo before mounting the application; registering again from a new
// temporary file fails in CoreText. Android's NSH text engine has its own map.
const INTER_FAMILY = 'Inter';

export function About() {
  const environment = signal(host.params as unknown as Environment);
  if (environment().platform !== 'ios') {
    void Promise.all([
      import('../assets/Inter-Regular.ttf'), import('../assets/Inter-Medium.ttf'), import('../assets/Inter-SemiBold.ttf'),
    ]);
  }
  const expanded = signal(false);
  const checking = signal(false);
  const failed = signal(false);
  const update = signal<{ latestVersion: string; updateAvailable: boolean } | null>(null);
  const translate = translations();
  const t = (key: string, values?: Record<string, string>) => translate(environment().locale, key, values);
  const colors = () => environment().colors;
  const press = (action: () => void) => () => { host.post('haptic'); action(); };
  const protocol = WhipAbout.protocolLabel(); // Direct QuickJS -> NSH Rust -> whip-ssh.
  const off = host.on('environment', data => environment.set(data as unknown as Environment));
  effect(() => setColorScheme(environment().isDark ? 'dark' : 'light'));
  let controller: AbortController | undefined;
  let disposed = false;
  cleanup(() => { disposed = true; off(); controller?.abort(); });

  const perform = async (name: string, data: Record<string, string>, errorKey: string) => {
    try { await host.call(name, data, { timeout: name === 'share' ? 0 : 30_000 }); }
    catch (error) {
      if (!disposed) await host.call('alert', { title: t(errorKey), message: String(error) });
    }
  };
  const open = (url: string, errorKey = 'about.githubError') =>
    perform('openURL', { url }, errorKey);
  const share = (url: string, title: string, message: string, error = 'about.shareError') =>
    perform('share', { title: t(title), message: t(message, { url }) }, error);
  const check = async () => {
    if (checking()) return;
    checking.set(true); failed.set(false); update.set(null);
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), UPDATE_CHECK_TIMEOUT_MS);
    try {
      const response = await fetch(LATEST_RELEASE_API_URL, {
        headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) throw new Error(`GitHub release check failed (${response.status})`);
      const result = JSON.parse(WhipAbout.evaluateUpdate(environment().version, await response.text()));
      if (!disposed) update.set(result);
    } catch {
      if (!disposed) failed.set(true);
    } finally {
      clearTimeout(timeout);
      if (!disposed) checking.set(false);
    }
  };

  const touchSize = () => environment().platform === 'ios' ? 44 : 48;
  const surfaceBorder = () => environment().glassEnabled
    ? environment().isDark ? '#ffffff1a' : '#ffffff4d' : colors().divider;

  function Backdrop(props: { nested?: boolean }) {
    const glass = () => environment().glassEnabled;
    const liquidAvailable = () => glass() && environment().platform === 'ios' && environment().liquidGlassAvailable;
    // Controls share the card's glass. Stacking NSH's glass effects here
    // refracts the wallpaper twice and gives the links much brighter edges.
    const liquid = () => liquidAvailable() && !props.nested;
    return <View accessible={false} ios={{ backdropMaterial: 'ultraThin' }} style={{
      position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, pointerEvents: 'none', borderRadius: CARD_RADIUS,
      backgroundColor: !glass() ? colors().surface : liquidAvailable() ? 'transparent'
        : environment().isDark ? '#14162261' : '#ffffff6b',
      // Android's existing GlassBackdrop uses a tint without a screen blur.
      backdropFilter: glass() && environment().platform === 'ios' && !(props.nested && liquidAvailable()) ? 'blur(10.8px)' : undefined,
      glassEffect: liquid() ? 'clear' : 'none',
    }} />;
  }
  function Label(props: { children: JSX.Element; muted?: boolean; size?: number; strong?: boolean;
    weight?: number; lineHeight?: number; align?: 'center' | 'right'; color?: string; opacity?: number; underline?: boolean }) {
    return <Text style={{ color: props.muted ? colors().textSecondary : colors().text,
      fontFamily: INTER_FAMILY, fontSize: props.size ?? 14, lineHeight: props.lineHeight ?? 20,
      fontWeight: props.weight ?? (props.strong ? 600 : 400), textAlign: props.align,
      ...(props.color ? { color: props.color } : {}), opacity: props.opacity ?? 1,
      textDecorationLine: props.underline ? 'underline' : 'none' }}>{props.children}</Text>;
  }
  function Action(props: { label: string; onPress: () => void; children?: JSX.Element; disabled?: boolean;
    link?: boolean; variant?: 'outline' | 'link' | 'primary' | 'surface'; style?: ViewStyle }) {
    const variant = props.variant ?? 'outline';
    return <Button accessibilityLabel={props.label} disabled={props.disabled}
      role={props.link ? 'link' : 'button'} onPress={press(props.onPress)}
      activeStyle={{ opacity: 0.7 }} disabledStyle={{ opacity: 0.5 }}
      style={{ minHeight: touchSize(), minWidth: touchSize(), paddingHorizontal: variant === 'link' ? 8 : 16,
        paddingVertical: variant === 'link' ? 0 : 8, borderRadius: variant === 'surface' ? CARD_RADIUS : CONTROL_RADIUS,
        borderWidth: variant === 'surface' || variant === 'outline' ? 1 : 0,
        borderColor: variant === 'surface' ? environment().isDark ? '#ffffff1a' : '#ffffff4d'
          : environment().isDark ? colors().surfaceRaised : colors().divider,
        backgroundColor: variant === 'surface' ? environment().isDark ? `${colors().surfaceRaised}4d` : 'transparent'
          : variant === 'primary' ? colors().primary : variant === 'outline'
          ? environment().isDark ? `${colors().surfaceRaised}4d` : colors().canvas : 'transparent',
        overflow: 'hidden', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        ...props.style }}>
      {variant === 'surface' ? <Backdrop nested /> : null}
      {props.children ?? <Label weight={500} color={variant === 'primary' ? colors().onPrimary : undefined}>{props.label}</Label>}
    </Button>;
  }
  function Badge(props: { name: IconName; primary?: boolean }) {
    return <View accessible={false} style={{ width: 40, height: 40, flexShrink: 0, borderRadius: 20,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: environment().glassEnabled ? 'transparent' : props.primary ? `${colors().primary}1a` : colors().surfaceRaised,
      borderWidth: environment().glassEnabled ? 1 : 0, borderColor: `${colors().text}47` }}>
      <Icon name={props.name} size={20} color={props.primary ? colors().primary : colors().text} />
    </View>;
  }
  function Heading(props: { label: string; marginTop?: number }) {
    return <View style={{ marginTop: props.marginTop ?? 36, marginBottom: 12, paddingHorizontal: 4 }}>
      <Label muted strong>{props.label}</Label></View>;
  }
  function Row(props: { label: string; value: string }) {
    return <View style={{ minHeight: 68, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1,
      borderColor: colors().divider, flexDirection: 'row', alignItems: 'center', gap: 16 }}>
      <View style={{ flex: 1 }}><Label size={15} strong>{props.label}</Label></View>
      <View style={{ flexShrink: 1, maxWidth: '60%' }}><Label weight={500} align="right">{props.value}</Label></View>
    </View>;
  }
  function Site(props: { label: string; detail: string; image: typeof github; url: string; error?: string; share?: () => void; shareLabel?: string }) {
    return <View style={{ flexDirection: 'row', gap: 10 }}>
      <View style={{ flex: 1 }}><Action label={props.label} link variant="surface"
        style={{ minHeight: 76, paddingHorizontal: 16, paddingVertical: 16, justifyContent: 'flex-start' }} onPress={() => void open(props.url, props.error)}>
        <View style={{ width: ICON_SIZE, height: ICON_SIZE, flexShrink: 0, overflow: 'hidden',
          borderRadius: props.image === github || props.image === x ? ICON_SIZE / 2 : props.image === herdr ? ICON_SIZE / 4 : 12,
          backgroundColor: props.image === github || props.image === x ? '#000000' : '#ffffff',
          alignItems: 'center', justifyContent: 'center' }}>
          <Image src={props.image} accessibilityLabel={props.image === herdr ? t('about.herdrIcon') : undefined}
            style={{ width: props.image === github ? 22 : props.image === x ? 20 : ICON_SIZE,
              height: props.image === github ? 22 : props.image === x ? 20 : ICON_SIZE, objectFit: 'contain' }} />
        </View>
        <View style={{ flex: 1, gap: 2 }}><Label size={15} strong>{props.label}</Label>
          <Label muted size={12} lineHeight={17}>{props.detail}</Label></View>
        <Icon name="externalLink" size={19} color={colors().textSecondary} />
      </Action></View>
      {props.share ? <Action label={props.shareLabel!} variant="surface" style={{ width: SHARE_WIDTH, paddingHorizontal: 0,
        alignSelf: 'stretch' }} onPress={props.share}><Icon name="share" size={21} color={colors().text} /></Action> : null}
    </View>;
  }

  return <View style={{ flexShrink: 0, paddingHorizontal: 16, paddingVertical: 8 }}
    onLayout={event => host.post('height', { height: event.bounds.size.height })}>
    <View testID="about-card" style={{ borderRadius: CARD_RADIUS, borderWidth: 1, borderColor: surfaceBorder(), overflow: 'hidden' }}>
      <Backdrop />
      <View role="button" testID="about-toggle" accessibilityLabel={t(expanded() ? 'about.collapse' : 'about.expand')}
        accessibilityState={{ expanded: expanded() }} onPress={press(() => expanded.set(!expanded()))}
        activeStyle={{ opacity: 0.7 }}
        style={{ minHeight: 72, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Badge name="info" /><View style={{ flex: 1, gap: 2 }}>
          <Label size={17} lineHeight={24} strong>{t('about.title')}</Label>
          <Label muted size={12} lineHeight={17}>{t('about.copy')}</Label>
        </View><Icon name={expanded() ? 'chevronUp' : 'chevronDown'} size={21} color={colors().textSecondary} />
      </View>
      {expanded() ? <View testID="about-content" style={{ padding: 16, borderTopWidth: 1, borderColor: colors().divider }}>
        <Heading label={t('about.source')} marginTop={0} />
        <View style={{ gap: 10 }}>
          <Site label={t('about.githubRepository')} detail="kosumic/whip" image={github} url={WHIP_REPOSITORY_URL}
            shareLabel={t('about.shareRepository')} share={() => void share(WHIP_REPOSITORY_URL, 'about.shareTitle', 'about.shareMessage')} />
          <Site label="X" detail="@Kosumi1989" image={x} url={X_PROFILE_URL} error="about.xError" />
          <Site label={t('about.herdrWebsite')} detail="herdr.dev" image={herdr} url={HERDR_WEBSITE_URL} error="about.herdrWebsiteError"
            shareLabel={t('about.shareHerdrWebsite')} share={() => void share(HERDR_WEBSITE_URL, 'about.shareHerdrTitle', 'about.shareHerdrMessage', 'about.shareHerdrError')} />
        </View>
        <View style={{ alignItems: 'center', marginTop: 36 }}>
          <Image src={whip} accessibilityLabel={t('about.appIcon')} style={{ width: 82, height: 82, objectFit: 'contain' }} />
          <View style={{ marginTop: 16 }}><Label size={28} lineHeight={36} strong>Whip</Label></View>
          <View style={{ marginTop: 4 }}><Label muted align="center">{t('about.tagline')}</Label></View>
          <View style={{ marginTop: 6 }}><Label muted size={12} lineHeight={17} align="center" opacity={0.7}>
            {t('common.version', { version: environment().version })}</Label></View>
          {environment().commit ? <Action link variant="link" style={{ marginTop: 2, gap: 4 }}
            label={t('about.openCommit', { hash: environment().commit!.slice(0, 12) })}
            onPress={() => void open(`${WHIP_REPOSITORY_URL}/commit/${environment().commit}`, 'about.commitError')}>
            <Label size={12} lineHeight={17} align="center" weight={500} color={colors().primary} underline>
              {t('about.commit', { hash: environment().commit!.slice(0, 12) })}</Label>
            <Icon name="externalLink" size={12} color={colors().primary} />
          </Action> : null}
          {environment().channel === 'github' ? <View style={{ marginTop: 16, width: '100%', alignItems: 'center', gap: 8 }}>
            <Action label={t(checking() ? 'about.checkingUpdates' : 'about.checkUpdates')} disabled={checking()} onPress={() => void check()}>
              <Icon name="refresh" size={16} color={colors().text} />
              <Label weight={500}>{t(checking() ? 'about.checkingUpdates' : 'about.checkUpdates')}</Label>
            </Action>
            {failed() || update() ? <Text android={{ accessibilityLiveRegion: 'polite' }} style={{ color: colors().textSecondary,
              fontFamily: INTER_FAMILY, fontSize: 12, lineHeight: 18, textAlign: 'center', paddingHorizontal: 4 }}>
              {failed() ? t('about.updateCheckError') : update()?.updateAvailable ? t('about.updateAvailable', { version: update()!.latestVersion }) : t('about.upToDate')}
            </Text> : null}
            {update()?.updateAvailable ? <Action label={t('about.viewUpdate')} variant="link" link onPress={() => void open(WHIP_LATEST_RELEASE_URL)}>
              <Icon name="download" size={16} color={colors().primary} />
              <Label weight={500} color={colors().primary}>{t('about.viewUpdate')}</Label></Action> : null}
          </View> : null}
        </View>
        <View style={{ marginTop: 36, alignItems: 'center' }}>
          <View style={{ marginBottom: 12 }}><Label muted strong>{t('about.shareApp')}</Label></View>
          <Image src={qr} accessibilityLabel={t('about.installQr')} style={{ width: 240, maxWidth: '100%', height: 240, objectFit: 'contain' }} />
          <Action label={t('about.openInstallLink')} variant="link" link style={{ marginTop: 8, maxWidth: '100%', paddingHorizontal: 4, gap: 4 }}
            onPress={() => void open(WHIP_INSTALL_URL, 'about.installLinkError')}>
            <View style={{ flexShrink: 1 }}><Label align="center" weight={500} color={colors().primary} underline>{WHIP_INSTALL_URL}</Label></View>
            <Icon name="externalLink" size={15} color={colors().primary} />
          </Action>
          <Action label={t('about.shareApp')} variant="primary" style={{ marginTop: 8, width: '100%' }}
            onPress={() => void share(WHIP_INSTALL_URL, 'about.shareApp', 'about.installShareMessage')}>
            <Icon name="share" size={18} color={colors().onPrimary} /><Label weight={500} color={colors().onPrimary}>{t('about.shareApp')}</Label>
          </Action>
        </View>
        <Heading label={t('about.legal')} />
        <Action label={t('about.openLicenses')} variant="surface" style={{ minHeight: 72, width: '100%',
          justifyContent: 'flex-start', paddingHorizontal: 16, paddingVertical: 12 }} onPress={() => host.post('licenses', null)}>
          <Badge name="scale" primary />
          <View style={{ flex: 1, gap: 2 }}><Label size={15} strong>{t('licenses.title')}</Label>
            <Label muted size={12} lineHeight={17}>{t('about.licensesCopy')}</Label></View>
          <Icon name="chevronRight" size={20} color={colors().textSecondary} />
        </Action>
        <Heading label={t('about.compatibility')} />
        <Row label={t('about.supportedHerdr')} value={t('common.protocol', { version: protocol })} />
        <Heading label={t('about.terminalFonts')} marginTop={32} />
        <Row label={t('about.terminalTextFont')} value={fonts.text.displayName} />
        <Row label={t('about.terminalCjkFont')} value={fonts.cjk.displayName} />
        <Row label={t('about.terminalSymbolFont')} value={[fonts.symbols.displayName, fonts.unicodeSymbols.displayName].join(', ')} />
        <Row label={t('about.terminalEmojiFont')} value={fonts.emoji.displayName} />
        <Row label={t('about.terminalFallbackFont')} value={environment().platform === 'ios' ? fonts.fallback.ios.displayName : fonts.fallback.android.displayName} />
        <Heading label={t('about.featuredProjects')} />
        <Site label="GoVue" detail={t('about.goVueDescription')} image={govue} url={GOVUE_REPOSITORY_URL} />
      </View> : null}
    </View>
  </View>;
}

mount(About);
