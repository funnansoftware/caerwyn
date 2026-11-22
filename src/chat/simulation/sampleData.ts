// Invented chatters and lines for the chat simulator. None of these are real accounts.

/** Twitch global emotes, by the name typed in chat. The IDs are real so the images load. */
export const TWITCH_EMOTES: Record<string, string> = {
	Kappa: '25',
	Kreygasm: '41',
	ResidentSleeper: '245',
	HeyGuys: '30259',
	NotLikeThis: '58765',
	SeemsGood: '64138',
	VoHiYo: '81274',
	LUL: '425618',
	PogChamp: '305954156',
};

export interface TwitchChatter {
	id: string;
	login: string;
	name: string;
	/** Empty when the user never picked a colour, as Twitch sends it. */
	color: string;
	badges: string[];
}

export const TWITCH_BROADCASTER: TwitchChatter = {
	id: 'sim-t0',
	login: 'caerwyn_demo',
	name: 'caerwyn_demo',
	color: '#FF7F50',
	badges: ['broadcaster', 'subscriber'],
};

export const TWITCH_CHATTERS: TwitchChatter[] = [
	{ id: 'sim-t1', login: 'pixel_wren', name: 'pixel_wren', color: '#1E90FF', badges: ['moderator', 'subscriber'] },
	{ id: 'sim-t2', login: 'mossy_keys', name: 'Mossy_Keys', color: '#2E8B57', badges: ['subscriber'] },
	{ id: 'sim-t3', login: 'quietotter', name: 'quietotter', color: '', badges: ['vip'] },
	{ id: 'sim-t4', login: 'tabs_not_spaces', name: 'tabs_not_spaces', color: '#0000FF', badges: [] },
	{ id: 'sim-t5', login: 'lanternfish42', name: 'Lanternfish42', color: '#FF69B4', badges: ['subscriber'] },
	{ id: 'sim-t6', login: 'null_pointer_nia', name: 'null_pointer_nia', color: '#8A2BE2', badges: [] },
	{ id: 'sim-t7', login: 'brambleworks', name: 'Brambleworks', color: '#DAA520', badges: ['founder'] },
	{ id: 'sim-t8', login: 'okapi_dev', name: 'okapi_dev', color: '', badges: [] },
	{ id: 'sim-t9', login: 'semicolon_sam', name: 'semicolon_sam', color: '#FF4500', badges: ['subscriber'] },
	{ id: 'sim-t10', login: 'verdant_loop', name: 'verdant_loop', color: '#9ACD32', badges: [] },
	{ id: 'sim-t11', login: 'a_really_quite_long_name', name: 'A_Really_Quite_Long_Name', color: '#FFFF66', badges: [] },
	{ id: 'sim-t12', login: 'kestrel_codes', name: 'kestrel_codes', color: '#5F9EA0', badges: ['moderator'] },
	{ id: 'sim-t13', login: 'ducklingdebug', name: 'DucklingDebug', color: '#B22222', badges: ['partner'] },
	{ id: 'sim-t14', login: 'haruka_ch', name: 'はるか', color: '#00FF7F', badges: ['subscriber'] },
	{ id: 'sim-t15', login: 'firstlight_fen', name: 'firstlight_fen', color: '', badges: [] },
	{ id: 'sim-t16', login: 'copperkettle', name: 'copperkettle', color: '#D2691E', badges: [] },
];

/** The chatter whose messages get removed when the showcase demonstrates moderation. */
export const TWITCH_TROUBLEMAKER: TwitchChatter = { id: 'sim-t99', login: 'totally_real_giveaway', name: 'totally_real_giveaway', color: '', badges: [] };

export interface YouTubeChatter {
	channelId: string;
	name: string;
	moderator?: boolean;
	member?: boolean;
	verified?: boolean;
	owner?: boolean;
}

export const YOUTUBE_OWNER: YouTubeChatter = { channelId: 'sim-y0', name: 'Caerwyn Demo', owner: true };

export const YOUTUBE_CHATTERS: YouTubeChatter[] = [
	{ channelId: 'sim-y1', name: 'Dana K.', member: true },
	{ channelId: 'sim-y2', name: 'Marisol Vega', moderator: true },
	{ channelId: 'sim-y3', name: 'Theo Lindqvist' },
	{ channelId: 'sim-y4', name: 'Rustacean Ray', member: true },
	{ channelId: 'sim-y5', name: 'Priya S' },
	{ channelId: 'sim-y6', name: 'Oluwaseun A.' },
	{ channelId: 'sim-y7', name: 'Tiny Compiler', verified: true },
	{ channelId: 'sim-y8', name: 'Jo from the back row' },
	{ channelId: 'sim-y9', name: 'محمد', member: true },
	{ channelId: 'sim-y10', name: 'Wren & Finch Studio' },
];

export const YOUTUBE_TROUBLEMAKER: YouTubeChatter = { channelId: 'sim-y99', name: 'Free Prizes Here' };

export const SPAM_LINE = 'click my profile for free prizes!!!';

/** Ordinary chat lines. Words that match a Twitch emote name become emotes in Twitch messages. */
export const CHAT_LINES = [
	'hello everyone',
	'just got here, what did I miss?',
	'HeyGuys',
	'that fixed it PogChamp',
	'LUL',
	'wait, why does that work',
	'can you make the font a bit bigger?',
	'what theme is that?',
	'gg',
	'this is the cleanest setup I have seen',
	'NotLikeThis the tests',
	'try turning it off and on again Kappa',
	'which keyboard are you using?',
	'first time here, loving the stream',
	'is this TypeScript?',
	'SeemsGood',
	'you forgot to save the file',
	'what are we building today?',
	'that bug has been haunting me all week',
	'audio is a little quiet',
	'ship it',
	'ResidentSleeper waiting for the build',
	'how long have you been coding?',
	'that was fast',
	'can you explain that last part again?',
	'🎉🎉🎉',
	'good evening from Lisbon',
	'ooh nice',
	'line 42 looks suspicious',
	'VoHiYo',
	'it compiles! Kreygasm',
	'rubber duck debugging works every time',
	'lol',
	'could you scroll up a bit?',
	'the tab layout is so nice',
	'brb getting tea',
	'this is exactly the tutorial I needed',
	'no way',
	'does it work on Linux too?',
	'<b>not bold</b> & "quotes" stay as text',
];

/** YouTube-only lines: global emoji shortcodes become emotes in YouTube messages. */
export const YOUTUBE_LINES = [
	':hand-pink-waving: hi from YouTube',
	'that bug is finally gone :text-green-game-over:',
	':face-blue-smiling::face-blue-smiling:',
	'see you at 10:30: same time tomorrow :yt:',
];

export const LONG_LINES = [
	'I ran into almost the same problem last month and it turned out the cache was holding on to a stale build, so every change I made looked like it did nothing until I wiped the output folder and rebuilt from scratch, which took me far longer to work out than I would like to admit',
	'longunbrokenwordtocheckthatwrappingstillbehaveswhensomeonepastesaverylongtokenorurlintochatwithoutanyspacesatall_https://example.com/a/really/long/path/that/keeps/going/and/going/and/going?with=query&and=more',
];

export const SUPER_CHAT_AMOUNTS = ['$2.00', '$5.00', '€10.00', '£20.00', '$50.00', '¥1,000'];
