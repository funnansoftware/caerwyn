import * as vscode from 'vscode';
import { ThemeHost, ThemeInfo, ThemeKind } from './themeControl';

const KINDS: Record<string, ThemeKind> = { vs: 'light', 'vs-dark': 'dark', 'hc-black': 'highContrast', 'hc-light': 'highContrastLight' };

interface ContributedTheme {
	id?: unknown;
	label?: unknown;
	uiTheme?: unknown;
}

/** Reads and writes the color theme in the user's own settings. */
export function vscodeThemeHost(): ThemeHost {
	const workbench = () => vscode.workspace.getConfiguration('workbench');
	return {
		themes: installedThemes,
		userTheme: () => workbench().inspect<string>('colorTheme')?.globalValue,
		currentTheme: () => workbench().get<string>('colorTheme'),
		setUserTheme: async (theme) => {
			// The user's settings, never the workspace's: a theme must not end up committed to the project.
			await workbench().update('colorTheme', theme, vscode.ConfigurationTarget.Global);
		},
		blocked: () => {
			const theme = workbench().inspect<string>('colorTheme');
			if (theme?.workspaceValue !== undefined || theme?.workspaceFolderValue !== undefined) {
				return 'This workspace sets its own color theme.';
			}
			const window = vscode.workspace.getConfiguration('window');
			// With these, VS Code shows its preferred theme for the system's appearance and ignores `workbench.colorTheme`.
			if (window.get<boolean>('autoDetectColorScheme')) {
				return 'VS Code follows the system light or dark mode (window.autoDetectColorScheme).';
			}
			// The system asked for high contrast, so VS Code shows that instead of the chosen theme.
			const kind = vscode.window.activeColorTheme.kind;
			const showingHighContrast = kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight;
			const chosen = installedThemes().find((info) => info.id === workbench().get<string>('colorTheme'));
			const choseHighContrast = chosen?.kind === 'highContrast' || chosen?.kind === 'highContrastLight';
			if (window.get<boolean>('autoDetectHighContrast') && showingHighContrast && !choseHighContrast) {
				return 'VS Code is showing a high contrast theme for the system.';
			}
			return undefined;
		},
	};
}

function installedThemes(): ThemeInfo[] {
	return vscode.extensions.all.flatMap((extension) => {
		const themes = (extension.packageJSON as { contributes?: { themes?: unknown } })?.contributes?.themes;
		return Array.isArray(themes) ? themes.flatMap((theme: ContributedTheme) => toInfo(theme)) : [];
	});
}

function toInfo(theme: ContributedTheme): ThemeInfo[] {
	const label = typeof theme.label === 'string' ? theme.label : undefined;
	// The setting takes a theme's ID, or its label when it has none.
	const id = typeof theme.id === 'string' ? theme.id : label;
	if (!id) {
		return [];
	}
	return [{ id, label: label && !label.startsWith('%') ? label : id, kind: KINDS[String(theme.uiTheme)] ?? 'dark' }];
}
