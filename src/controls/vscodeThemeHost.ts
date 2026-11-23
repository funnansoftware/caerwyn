import * as vscode from 'vscode';
import { ThemeHost, ThemeInfo, ThemeKind, ThemeSetting } from './themeControl';

const KINDS: Record<string, ThemeKind> = { vs: 'light', 'vs-dark': 'dark', 'hc-black': 'highContrast', 'hc-light': 'highContrastLight' };

const SHOWING: Record<vscode.ColorThemeKind, ThemeKind> = {
	[vscode.ColorThemeKind.Light]: 'light',
	[vscode.ColorThemeKind.Dark]: 'dark',
	[vscode.ColorThemeKind.HighContrast]: 'highContrast',
	[vscode.ColorThemeKind.HighContrastLight]: 'highContrastLight',
};

interface ContributedTheme {
	id?: unknown;
	label?: unknown;
	uiTheme?: unknown;
}

/** Reads and writes the color theme settings in the user's own settings. */
export function vscodeThemeHost(): ThemeHost {
	const workbench = () => vscode.workspace.getConfiguration('workbench');
	const window = () => vscode.workspace.getConfiguration('window');
	const showingKind = () => SHOWING[vscode.window.activeColorTheme.kind] ?? 'dark';
	return {
		themes: installedThemes,
		followsSystem: () => window().get<boolean>('autoDetectColorScheme') === true,
		showingKind,
		userTheme: (setting) => workbench().inspect<string>(setting)?.globalValue,
		currentTheme: (setting) => workbench().get<string>(setting),
		setUserTheme: async (setting, theme) => {
			// The user's settings, never the workspace's: a theme must not end up committed to the project.
			await workbench().update(setting, theme, vscode.ConfigurationTarget.Global);
		},
		blocked: (setting: ThemeSetting) => {
			const value = workbench().inspect<string>(setting);
			if (value?.workspaceValue !== undefined || value?.workspaceFolderValue !== undefined) {
				return 'This workspace sets its own color theme.';
			}
			// The system asked for high contrast, so VS Code shows that instead of the chosen theme.
			const showing = showingKind();
			const chosen = installedThemes().find((info) => info.id === workbench().get<string>(setting));
			const choseHighContrast = chosen?.kind === 'highContrast' || chosen?.kind === 'highContrastLight';
			if (window().get<boolean>('autoDetectHighContrast') && (showing === 'highContrast' || showing === 'highContrastLight') && !choseHighContrast) {
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
	// The settings take a theme's ID, or its label when it has none.
	const id = typeof theme.id === 'string' ? theme.id : label;
	if (!id) {
		return [];
	}
	return [{ id, label: label && !label.startsWith('%') ? label : id, kind: KINDS[String(theme.uiTheme)] ?? 'dark' }];
}
