import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { recordCrash } from './crashlog';
import { color, radius, space, type } from './theme';

type Props = { children: React.ReactNode };
type State = { error: Error | null };

/**
 * Catches render-time faults.
 *
 * The global ErrorUtils handler records an error but does not stop React from
 * unmounting the tree, so a render fault still leaves a blank or vanished app.
 * A boundary is the only thing that keeps something on screen, which is the
 * difference between a bug that can be reported and one that can only be
 * described as "it closed itself".
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Persisted as well as shown, so it survives a restart.
    void recordCrash(error, false);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.screen}>
        <Text style={styles.title}>Something broke on this screen</Text>
        <Text style={styles.body}>
          The rest of the app is still running. This is the fault, verbatim.
        </Text>
        <ScrollView style={styles.trace}>
          <Text style={styles.mono}>{error.message}</Text>
          <Text style={styles.mono}>{(error.stack ?? '').slice(0, 2000)}</Text>
        </ScrollView>
        <Pressable style={styles.retry} onPress={() => this.setState({ error: null })}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: color.canvas,
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  title: { ...type.title, color: color.danger },
  body: { ...type.muted },
  trace: {
    maxHeight: '55%',
    backgroundColor: color.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.line,
    padding: space.md,
  },
  mono: { color: color.ink, fontSize: 11, fontFamily: 'monospace', marginBottom: space.sm },
  retry: {
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    padding: space.lg,
    alignItems: 'center',
  },
  retryText: { color: color.onAccent, fontWeight: '700' },
});
