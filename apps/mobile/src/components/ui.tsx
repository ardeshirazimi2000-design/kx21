import { toPersianDigits } from '@kx/shared';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme, type Theme } from '../lib/theme';

export const fa = (v: string | number | null | undefined) => (v === null || v === undefined ? '—' : toPersianDigits(v));

// ───────── Keyboard handling ─────────
// Android 15+ draws apps edge-to-edge, so the window is no longer resized when the keyboard opens.
// Forms therefore pad their bottom by the keyboard height and scroll the focused field above it.

/** Top edge (screen Y) and height of the on-screen keyboard; 0 when hidden. */
export function useKeyboard() {
  const [kb, setKb] = useState({ height: 0, top: 0 });
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, (e) => setKb({ height: e.endCoordinates.height, top: e.endCoordinates.screenY }));
    const hide = Keyboard.addListener(hideEvt, () => setKb({ height: 0, top: 0 }));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return kb;
}

const RevealContext = createContext<(() => void) | null>(null);

/** Props for a ScrollView that keeps the focused input visible above the keyboard. */
export function useKeyboardAwareScroll() {
  const ref = useRef<ScrollView>(null);
  const offset = useRef(0);
  const kb = useKeyboard();
  const kbTop = useRef(0);
  kbTop.current = kb.height ? kb.top : 0;
  const reveal = useCallback(() => {
    setTimeout(() => {
      const input = TextInput.State.currentlyFocusedInput?.() as any;
      if (!input || !kbTop.current || !input.measureInWindow) return;
      input.measureInWindow((_x: number, y: number, _w: number, h: number) => {
        const overlap = y + h + 24 - kbTop.current;
        if (overlap > 0) ref.current?.scrollTo({ y: offset.current + overlap, animated: true });
      });
    }, 120);
  }, []);
  useEffect(() => {
    if (kb.height) reveal();
  }, [kb.height, reveal]);
  return {
    kbHeight: kb.height,
    reveal,
    scrollProps: {
      ref,
      keyboardShouldPersistTaps: 'handled' as const,
      scrollEventThrottle: 16,
      onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        offset.current = e.nativeEvent.contentOffset.y;
      },
    },
  };
}

/** Scrollable form area for screens and full-screen modals. */
export function KeyboardScroll({ children, contentContainerStyle, refreshControl }: { children: ReactNode; contentContainerStyle?: ViewStyle; refreshControl?: any }) {
  const { kbHeight, reveal, scrollProps } = useKeyboardAwareScroll();
  const base = (contentContainerStyle?.paddingBottom as number | undefined) ?? 16;
  return (
    <RevealContext.Provider value={reveal}>
      <ScrollView {...scrollProps} refreshControl={refreshControl} contentContainerStyle={[contentContainerStyle, { paddingBottom: base + kbHeight }]}>
        {children}
      </ScrollView>
    </RevealContext.Provider>
  );
}

/** Bottom padding equal to the keyboard height (for bottom sheets and fixed footers). */
export function KeyboardSpacer() {
  const { height } = useKeyboard();
  return height ? <View style={{ height }} /> : null;
}

export function Screen({ children, refreshing, onRefresh, scroll = true }: { children: ReactNode; refreshing?: boolean; onRefresh?: () => void; scroll?: boolean }) {
  const t = useTheme();
  if (!scroll) return <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['bottom']}>{children}</SafeAreaView>;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['bottom']}>
      <KeyboardScroll
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}
        refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}
      >
        {children}
      </KeyboardScroll>
    </SafeAreaView>
  );
}

export function T({ children, muted, bold, size, color, style }: { children: ReactNode; muted?: boolean; bold?: boolean; size?: number; color?: string; style?: object }) {
  const t = useTheme();
  return (
    <Text style={[{ color: color ?? (muted ? t.muted : t.text), fontWeight: bold ? '700' : '400', fontSize: size ?? 15, textAlign: 'right', writingDirection: 'rtl', lineHeight: (size ?? 15) * 1.6 }, style]}>
      {children}
    </Text>
  );
}

export function Card({ children, title, right, style, highlight }: { children?: ReactNode; title?: string; right?: ReactNode; style?: ViewStyle; highlight?: boolean }) {
  const t = useTheme();
  return (
    <View
      style={[
        { backgroundColor: t.surface, borderRadius: 12, borderWidth: highlight ? 2 : 1, borderColor: highlight ? t.primary : t.border, padding: 14, gap: 8 },
        style,
      ]}
    >
      {(title || right) && (
        <View style={styles.row}>
          {title ? <T bold size={16}>{title}</T> : <View />}
          {right}
        </View>
      )}
      {children}
    </View>
  );
}

type Variant = 'primary' | 'secondary' | 'success' | 'danger' | 'ghost';

export function Button({ title, onPress, variant = 'primary', busy, disabled, big }: { title: string; onPress: () => void; variant?: Variant; busy?: boolean; disabled?: boolean; big?: boolean }) {
  const t = useTheme();
  const bg: Record<Variant, string> = { primary: t.primary, secondary: t.surface, success: t.success, danger: t.danger, ghost: 'transparent' };
  const fg: Record<Variant, string> = { primary: t.primaryInk, secondary: t.text, success: '#fff', danger: '#fff', ghost: t.primary };
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => ({
        backgroundColor: bg[variant],
        borderRadius: 10,
        borderWidth: variant === 'secondary' ? 1 : 0,
        borderColor: t.border,
        paddingVertical: big ? 16 : 10,
        paddingHorizontal: 16,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        alignItems: 'center',
        flexDirection: 'row-reverse',
        justifyContent: 'center',
        gap: 8,
      })}
    >
      {busy && <ActivityIndicator color={fg[variant]} />}
      <Text style={{ color: fg[variant], fontWeight: '700', fontSize: big ? 18 : 15 }}>{title}</Text>
    </Pressable>
  );
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  const t = useTheme();
  const map: Record<Tone, [string, string]> = {
    neutral: [t.surface2, t.muted],
    info: [t.infoSoft, t.info],
    success: [t.successSoft, t.success],
    warning: [t.warningSoft, t.warning],
    danger: [t.dangerSoft, t.danger],
    accent: [t.warningSoft, t.accent],
  };
  const [bg, fg] = map[tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 2, alignSelf: 'flex-start' }}>
      <Text style={{ color: fg, fontSize: 12, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

export function Input(props: TextInputProps & { label?: string }) {
  const t = useTheme();
  const reveal = useContext(RevealContext);
  return (
    <View style={{ gap: 4 }}>
      {props.label && <T muted size={13}>{props.label}</T>}
      <TextInput
        placeholderTextColor={t.muted}
        {...props}
        onFocus={(e) => {
          reveal?.();
          props.onFocus?.(e);
        }}
        style={[{ borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12, color: t.text, backgroundColor: t.surface, textAlign: 'right', fontSize: 15 }, props.style]}
      />
    </View>
  );
}

export function ErrorText({ error }: { error?: Error | null }) {
  const t = useTheme();
  if (!error) return null;
  return (
    <View style={{ backgroundColor: t.dangerSoft, borderRadius: 10, padding: 10 }}>
      <T color={t.danger}>{error.message}</T>
    </View>
  );
}

export function Loading() {
  const t = useTheme();
  return (
    <View style={{ padding: 32, alignItems: 'center' }}>
      <ActivityIndicator color={t.primary} />
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <View style={{ padding: 24, alignItems: 'center' }}>
      <T muted>{text}</T>
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function ProgressBar({ value, theme }: { value: number; theme?: Theme }) {
  const t = theme ?? useTheme();
  return (
    <View style={{ height: 8, backgroundColor: t.surface2, borderRadius: 99, overflow: 'hidden', flexDirection: 'row-reverse' }}>
      <View style={{ width: `${Math.min(100, Math.max(0, value))}%`, backgroundColor: t.success }} />
    </View>
  );
}

export const styles = StyleSheet.create({
  row: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
});
