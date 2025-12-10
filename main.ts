import { Plugin, PluginSettingTab, Setting, Notice, TFile, MetadataCache, App, requestUrl, Modal, Editor, MarkdownView } from 'obsidian';

interface MultimuseObsidianSettings {
	botApiUrl: string; // Bot HTTP API URL (hidden from user UI for security)
	pollInterval: number; // in minutes
	scenesFolder: string;
	basePath: string; // Obsidian Base file path (e.g., "RP Scenes/Roleplay Tracker.base")
	ownerId: string; // DEPRECATED: Auto-synced from API key, kept for backward compatibility
	userIds: string; // DEPRECATED: Auto-synced from API key, kept for backward compatibility
	enabled: boolean;
	apiKey: string; // API key for authentication (Bearer token)
	cachedUserId: string; // Cached user ID from API key (auto-populated)
}

const DEFAULT_SETTINGS: MultimuseObsidianSettings = {
	botApiUrl: 'http://216.201.73.233:9056', // Hidden from user for security
	pollInterval: 15,
	scenesFolder: 'RP Scenes',
	basePath: '',
	ownerId: '', // Deprecated - auto-synced from API key
	userIds: '', // Deprecated - auto-synced from API key
	enabled: true,
	apiKey: '',
	cachedUserId: '' // Auto-populated from API key
};

interface MuseInfo {
	name: string;
	trigger: string;
	tags: string;
	owner_id: number;
	is_shared: boolean;
}

export default class MultimuseObsidian extends Plugin {
	settings: MultimuseObsidianSettings;
	pollIntervalId: number | null = null;
	museCache: Map<string, MuseInfo[]> = new Map(); // user_id (as string) -> muses

	async onload() {
		await this.loadSettings();

		// Add settings tab
		this.addSettingTab(new MultimuseObsidianSettingTab(this.app, this));

		// Sync muses on startup (auto-fetch user ID from API key)
		if (this.settings.apiKey) {
			await this.getUserIdFromApiKey(); // Cache user ID
			await this.syncMuses();
		}

		// Start polling if enabled
		if (this.settings.enabled && this.settings.apiKey) {
			this.startPolling();
		}

		// Add command to manually check now
		this.addCommand({
			id: 'check-discord-threads',
			name: 'Check Discord Threads Now',
			callback: () => {
				this.checkAllThreads();
			}
		});

		// Add command to toggle polling
		this.addCommand({
			id: 'toggle-polling',
			name: 'Toggle Discord Polling',
			callback: () => {
				this.settings.enabled = !this.settings.enabled;
				this.saveSettings();
				if (this.settings.enabled) {
					this.startPolling();
					new Notice('Discord polling enabled');
				} else {
					this.stopPolling();
					new Notice('Discord polling disabled');
				}
			}
		});

		// Add command to create new scene
		this.addCommand({
			id: 'create-scene',
			name: 'Create New Scene',
			callback: () => {
				this.createNewScene();
			}
		});

		// Add command to sync from tracker
		this.addCommand({
			id: 'sync-from-tracker',
			name: 'Sync from Tracker',
			callback: () => {
				this.syncFromTracker();
			}
		});

		// Watch for scene file creation/modification to check state
		this.registerEvent(
			this.app.vault.on('modify', async (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					await this.handleSceneFileChange(file);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on('create', async (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					await this.handleSceneFileChange(file);
				}
			})
		);

		// Add context menu item for sending text as muse
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor, view) => {
				menu.addItem((item) => {
					item.setTitle('Send as Muse')
						.setIcon('message-square')
						.onClick(async () => {
							// Type guard: ensure view is MarkdownView, not MarkdownFileInfo
							if (view instanceof MarkdownView) {
								await this.sendSelectionAsMuse(editor, view);
							} else {
								new Notice('This feature requires a markdown view.');
							}
						});
				});
			})
		);
	}

	onunload() {
		this.stopPolling();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// Ensure botApiUrl always uses default if empty or not set
		if (!this.settings.botApiUrl || this.settings.botApiUrl.trim() === '') {
			this.settings.botApiUrl = DEFAULT_SETTINGS.botApiUrl;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	startPolling() {
		this.stopPolling(); // Clear any existing interval
		
		if (!this.settings.ownerId) {
			new Notice('Discord user ID not configured. Please set it in settings.');
			return;
		}

		const intervalMs = this.settings.pollInterval * 60 * 1000;
		this.pollIntervalId = window.setInterval(() => {
			this.checkAllThreads();
		}, intervalMs);

		// Do an initial check
		this.checkAllThreads();
	}

	stopPolling() {
		if (this.pollIntervalId !== null) {
			window.clearInterval(this.pollIntervalId);
			this.pollIntervalId = null;
		}
	}

	/**
	 * Get the bot API URL, falling back to default if not set.
	 * @returns Bot API URL string
	 */
	getBotApiUrl(): string {
		if (!this.settings.botApiUrl || this.settings.botApiUrl.trim() === '') {
			return DEFAULT_SETTINGS.botApiUrl;
		}
		return this.settings.botApiUrl;
	}

	/**
	 * Get headers for API requests, including Authorization header if API key is set.
	 * @returns Headers object for requestUrl
	 */
	getApiHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json'
		};
		
		// Add Authorization header if API key is configured
		if (this.settings.apiKey && this.settings.apiKey.trim() !== '') {
			headers['Authorization'] = `Bearer ${this.settings.apiKey.trim()}`;
		}
		
		return headers;
	}

	/**
	 * Handle API response errors, especially authentication errors.
	 * @param response The response object from requestUrl
	 * @param context Context string for logging
	 * @returns true if error was handled, false otherwise
	 */
	handleApiError(response: any, context: string): boolean {
		if (response.status === 401) {
			const errorMsg = 'API authentication failed. Please check your API key in settings.';
			console.error(`[MultimuseObsidian] ${context}: ${errorMsg}`);
			new Notice(errorMsg);
			return true;
		}
		return false;
	}

	/**
	 * Get user ID from API key (cached or fetched fresh).
	 * @returns User ID string, or null if not available
	 */
	async getUserIdFromApiKey(): Promise<string | null> {
		// If we have a cached user ID and API key is set, use it
		if (this.settings.cachedUserId && this.settings.apiKey) {
			return this.settings.cachedUserId;
		}
		
		// If no API key, can't get user ID
		if (!this.settings.apiKey || this.settings.apiKey.trim() === '') {
			return null;
		}
		
		// Fetch user ID from API
		try {
			const url = `${this.getBotApiUrl()}/api/v1/auth/me`;
			const response = await requestUrl({
				url: url,
				method: 'GET',
				headers: this.getApiHeaders()
			});
			
			if (response.status === 200) {
				const data = JSON.parse(response.text);
				const userId = data.user_id;
				if (userId) {
					// Cache the user ID
					this.settings.cachedUserId = String(userId);
					// Also update deprecated fields for backward compatibility
					this.settings.ownerId = String(userId);
					this.settings.userIds = '';
					await this.saveSettings();
					return this.settings.cachedUserId;
				}
			} else {
				if (!this.handleApiError(response, 'getUserIdFromApiKey')) {
					console.error(`[MultimuseObsidian] Failed to get user ID from API: ${response.status}`);
				}
			}
		} catch (error) {
			console.error('[MultimuseObsidian] Error fetching user ID from API key:', error);
		}
		
		return null;
	}

	/**
	 * Collect all configured user IDs (now just from API key).
	 * @returns Array of user ID numbers
	 */
	async getAllUserIds(): Promise<string[]> {
		const userId = await this.getUserIdFromApiKey();
		if (userId) {
			return [userId];
		}
		// Fallback to old settings for backward compatibility
		const userIdSet = new Set<string>();
		if (this.settings.ownerId) {
			const ownerIds = this.settings.ownerId.split(',').map(id => id.trim()).filter(id => id.length > 0);
			ownerIds.forEach(id => userIdSet.add(id));
		}
		if (this.settings.userIds) {
			const additionalIds = this.settings.userIds.split(',').map(id => id.trim()).filter(id => id.length > 0);
			additionalIds.forEach(id => userIdSet.add(id));
		}
		return Array.from(userIdSet);
	}

	/**
	 * Get the primary user ID (from API key).
	 * @returns Primary user ID as string, or null if not configured
	 */
	async getPrimaryUserId(): Promise<string | null> {
		return await this.getUserIdFromApiKey();
	}

	async syncMuses(): Promise<void> {
		/**Sync muse names from bot API for all configured user IDs.*/
		if (!this.settings.apiKey) {
			return;
		}

		try {
			// Collect all user IDs (deduplicated) - now from API key
			const userIds = await this.getAllUserIds();
			if (userIds.length === 0) {
				return;
			}

			// Build query string - always use user_ids parameter for consistency
			const queryParam = `user_ids=${userIds.join(',')}`;

			const url = `${this.getBotApiUrl()}/api/v1/muses/list?${queryParam}`;

			const response = await requestUrl({
				url: url,
				method: 'GET',
				headers: this.getApiHeaders()
			});

			if (response.status === 200) {
				const data = JSON.parse(response.text);
				const muses: MuseInfo[] = data.muses || [];
				
				// Cache all muses for each user ID (API already returns all accessible muses for all provided user IDs)
				// Since the API returns muses that are either owned by or shared with any of the user IDs,
				// we cache all of them for each user ID so they're available when needed
				// Keep user IDs as strings to avoid precision loss with large Discord IDs
				for (const userId of userIds) {
					this.museCache.set(String(userId), muses);
				}
				
				console.log(`[MultimuseObsidian] Synced ${muses.length} muse(s) for ${userIds.length} user(s)`);
			} else {
				if (!this.handleApiError(response, 'syncMuses')) {
					console.error(`Failed to sync muses: ${response.status} - ${response.text}`);
				}
			}
		} catch (error) {
			console.error('Error syncing muses:', error);
		}
	}

	async checkAllThreads() {
		if (!this.settings.enabled || !this.settings.apiKey) {
			return;
		}

		await this.checkAllThreadsViaBotApi();
	}

	async checkAllThreadsViaBotApi(): Promise<void> {
		/**Check all scene files by querying the tracker API for linked scenes in batch.*/
		if (!this.settings.apiKey) {
			return;
		}

		try {
			// Get primary user ID for linked scenes query
			const primaryUserIdStr = await this.getPrimaryUserId();
			if (!primaryUserIdStr) {
				return;
			}
			const primaryUserId = parseInt(primaryUserIdStr);
			if (isNaN(primaryUserId)) {
				return;
			}

			// Get all linked scenes from the API
			const linkedUrl = `${this.getBotApiUrl()}/api/v1/scenes/linked?user_id=${primaryUserId}`;
			const linkedResponse = await requestUrl({
				url: linkedUrl,
				method: 'GET',
				headers: this.getApiHeaders()
			});

			if (linkedResponse.status !== 200) {
				if (!this.handleApiError(linkedResponse, 'checkAllThreadsViaBotApi')) {
					console.error(`[MultimuseObsidian] Failed to fetch linked scenes: ${linkedResponse.status} - ${linkedResponse.text}`);
				}
				return;
			}

			const linkedData = JSON.parse(linkedResponse.text);
			const linkedThreads = linkedData.linked_threads || [];

			if (linkedThreads.length === 0) {
				return;
			}

			// Create a map of scene_path -> thread info for quick lookup
			const scenePathMap = new Map<string, any>();
			for (const thread of linkedThreads) {
				if (thread.scene_path) {
					scenePathMap.set(thread.scene_path, thread);
				}
			}

			// Get all scene files
			const sceneFiles = this.getSceneFiles();
			let updatedCount = 0;

			// Process each scene file
			for (const file of sceneFiles) {
				try {
					const cache = this.app.metadataCache.getFileCache(file);
					if (!cache || !cache.frontmatter) {
						continue;
					}

					// Skip if scene is marked as inactive
					const isActive = cache.frontmatter['Is Active?'];
					if (isActive === false || isActive === 'false') {
						continue;
					}

					// Check if this scene is in the linked threads
					const threadInfo = scenePathMap.get(file.path);
					if (!threadInfo) {
						// Scene not linked, try querying by thread_id and characters
						const link = cache.frontmatter['Link'];
						if (!link) continue;

						const characters = this.getCharacterNames(cache.frontmatter);
						if (characters.length === 0) continue;

						const threadId = this.extractThreadIdFromUrl(link);
						if (!threadId) continue;

						// Query this scene individually
						const updated = await this.querySceneState(file);
						if (updated) {
							updatedCount++;
						}
					} else {
						// Scene is linked - query its state
						const characters = threadInfo.characters || [];
						if (characters.length === 0) continue;

						const charactersParam = Array.isArray(characters) ? characters.join(',') : characters;
						// Use primary user ID for query
						const primaryUserId = await this.getPrimaryUserId();
						if (!primaryUserId) {
							continue;
						}
						const queryUrl = `${this.getBotApiUrl()}/api/v1/scenes/query?thread_id=${threadInfo.thread_id}&characters=${encodeURIComponent(charactersParam)}&user_id=${primaryUserId}`;

						const queryResponse = await requestUrl({
							url: queryUrl,
							method: 'GET',
							headers: this.getApiHeaders()
						});

						if (queryResponse.status === 200) {
							const queryData = JSON.parse(queryResponse.text);
							
							if (queryData.tracked && queryData.state) {
								const state = queryData.state;
								const updated = await this.updateSceneFromState(file, cache, state);
								if (updated) {
									updatedCount++;
								}
							}
						} else {
							// Log auth errors but don't spam for every scene
							if (queryResponse.status === 401) {
								this.handleApiError(queryResponse, 'checkAllThreadsViaBotApi - query scene');
							}
						}
					}
				} catch (error) {
					console.error(`Error checking ${file.path}:`, error);
				}
			}

			if (updatedCount > 0) {
				new Notice(`Updated ${updatedCount} scene file(s)`);
			}
		} catch (error) {
			console.error(`[MultimuseObsidian] Error checking all threads:`, error);
		}
	}

	async querySceneState(file: TFile): Promise<boolean> {
		/**Query the tracker API for a specific scene's state and update frontmatter.*/
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache || !cache.frontmatter) {
			return false;
		}

		// Skip if scene is marked as inactive
		const isActive = cache.frontmatter['Is Active?'];
		if (isActive === false || isActive === 'false') {
			return false; // Skip inactive scenes
		}

		const link = cache.frontmatter['Link'];
		if (!link) {
			return false;
		}

		const characters = this.getCharacterNames(cache.frontmatter);
		if (characters.length === 0) {
			return false;
		}

		const threadId = this.extractThreadIdFromUrl(link);
		if (!threadId) {
			return false;
		}

		try {
			// Query the tracker API for this specific scene
			const charactersParam = characters.join(',');
			// Use primary user ID for query
			const primaryUserId = await this.getPrimaryUserId();
			if (!primaryUserId) {
				return false;
			}
			const url = `${this.getBotApiUrl()}/api/v1/scenes/query?thread_id=${threadId}&characters=${encodeURIComponent(charactersParam)}&user_id=${primaryUserId}`;

			const response = await requestUrl({
				url: url,
				method: 'GET',
				headers: this.getApiHeaders()
			});

			if (response.status !== 200) {
				if (!this.handleApiError(response, `querySceneState for ${file.path}`)) {
					console.error(`[MultimuseObsidian] API error for ${file.path}: ${response.status} - ${response.text}`);
				}
				return false;
			}

			const data = JSON.parse(response.text);
			
			// If scene is not tracked, don't update anything
			if (!data.tracked || !data.state) {
				return false;
			}

			const state = data.state;
			return await this.updateSceneFromState(file, cache, state);
		} catch (error) {
			console.error(`[MultimuseObsidian] Error querying scene state for ${file.path}:`, error);
			return false;
		}
	}

	async updateSceneFromState(file: TFile, cache: any, state: any): Promise<boolean> {
		/**Update scene frontmatter from API state data.*/
		let updated = false;

		// Update Replied? field - normalize boolean values for comparison
		const currentRepliedRaw = cache.frontmatter['Replied?'];
		// Handle both boolean and string values
		const currentReplied = currentRepliedRaw === true || currentRepliedRaw === 'true' || currentRepliedRaw === 'True';
		const shouldBeReplied = state.replied === true || state.replied === 'true'; // true = your turn, false = not your turn

		if (currentReplied !== shouldBeReplied) {
			console.log(`[MultimuseObsidian] ${file.basename}: Updated Replied? to ${shouldBeReplied}`);
			await this.updateFrontmatter(file, 'Replied?', shouldBeReplied);
			updated = true;
		}

		// Update Participants field
		const currentParticipants = cache.frontmatter['Participants'] || cache.frontmatter['participants'];
		const shouldBeParticipants = state.participants || 2;

		if (currentParticipants !== shouldBeParticipants) {
			console.log(`[MultimuseObsidian] ${file.basename}: Updated Participants to ${shouldBeParticipants}`);
			await this.updateFrontmatter(file, 'Participants', shouldBeParticipants);
			updated = true;
		}

		return updated;
	}


	async handleSceneFileChange(file: TFile): Promise<void> {
		/**Handle scene file creation/modification - scenes are auto-detected when queried, no registration needed.*/
		// Only process files in the scenes folder
		if (!file.path.startsWith(this.settings.scenesFolder + '/')) {
			return;
		}

		// Only process if enabled and API key is set
		if (!this.settings.apiKey || !this.settings.enabled) {
			return;
		}

		// Small delay to avoid checking during file creation
		await new Promise(resolve => setTimeout(resolve, 1000));

		// Query the scene state - this will auto-detect if it matches a tracked thread
		try {
			await this.querySceneState(file);
		} catch (error) {
			// Silently fail - don't spam errors for every file change
			console.debug(`Error checking scene ${file.path}:`, error);
		}
	}


	getSceneFiles(): TFile[] {
		const folder = this.app.vault.getAbstractFileByPath(this.settings.scenesFolder);
		if (!folder) {
			return [];
		}

		const files: TFile[] = [];
		this.collectMarkdownFiles(folder, files);
		return files;
	}

	collectMarkdownFiles(fileOrFolder: any, files: TFile[]): void {
		if (fileOrFolder instanceof TFile && fileOrFolder.extension === 'md') {
			files.push(fileOrFolder);
		} else if ('children' in fileOrFolder) {
			for (const child of fileOrFolder.children) {
				this.collectMarkdownFiles(child, files);
			}
		}
	}


	getCharacterNames(frontmatter: any): string[] {
		const characters = frontmatter['Characters'];
		if (!characters) {
			return [];
		}

		// Handle both array and single value
		if (Array.isArray(characters)) {
			return characters.map(c => String(c).trim());
		} else if (typeof characters === 'string') {
			// Handle comma-separated string
			return characters.split(',').map(c => c.trim()).filter(c => c.length > 0);
		}

		return [String(characters).trim()];
	}


	extractThreadIdFromUrl(url: string): string | null {
		if (!url || typeof url !== 'string') {
			return null;
		}

		// Discord URL formats:
		// Thread URL: https://discord.com/channels/GUILD_ID/CHANNEL_ID/THREAD_ID (3 IDs - extract last)
		// Channel/Thread URL: https://discord.com/channels/GUILD_ID/THREAD_ID (2 IDs - extract second)
		// Also handle canary.discord.com
		const match3 = url.match(/discord(?:app)?(?:canary)?\.com\/channels\/\d+\/\d+\/(\d+)/);
		if (match3) {
			return match3[1]; // Thread URL with 3 IDs
		}
		
		const match2 = url.match(/discord(?:app)?(?:canary)?\.com\/channels\/\d+\/(\d+)/);
		if (match2) {
			return match2[1]; // Channel/Thread URL with 2 IDs (thread ID is the channel ID)
		}
		
		return null;
	}


	async updateFrontmatter(file: TFile, key: string, value: any): Promise<void> {
		const content = await this.app.vault.read(file);
		
		// Parse frontmatter
		const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
		const match = content.match(frontmatterRegex);
		
		if (!match) {
			console.error(`[MultimuseObsidian] No frontmatter found in ${file.path}`);
			return;
		}

		let frontmatterText = match[1];
		const body = content.slice(match[0].length);

		// Escape special regex characters in the key
		const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		
		// Format value for YAML (handle booleans, strings, etc.)
		let formattedValue: string;
		if (typeof value === 'boolean') {
			formattedValue = value.toString(); // "true" or "false"
		} else if (typeof value === 'string') {
			formattedValue = value;
		} else {
			formattedValue = String(value);
		}
		
		// Update the key-value pair - match the key at the start of a line
		// Handle both single-line and multi-line values
		// Match any value after the colon (including true/false, "true"/"false", etc.)
		const keyRegex = new RegExp(`^${escapedKey}:\\s*(.+)$`, 'gm');
		const keyMatch = frontmatterText.match(keyRegex);

		if (keyMatch) {
			// Replace ALL occurrences of the key (in case there are duplicates)
			// Always update to the new value
			frontmatterText = frontmatterText.replace(keyRegex, `${key}: ${formattedValue}`);
		} else {
			// Add new key-value pair at the end
			frontmatterText += `\n${key}: ${formattedValue}`;
		}

		// Reconstruct file content
		const newContent = `---\n${frontmatterText}\n---\n${body}`;
		
		await this.app.vault.modify(file, newContent);
	}

	// ========= NEW COMMAND METHODS =========

	async createNewScene(): Promise<void> {
		/**Create a new scene with muse selection, thread link, location, name, and participants.*/
		if (!this.settings.apiKey) {
			new Notice('API key must be configured in settings.');
			return;
		}

		// 1) Get muses from bot API for all configured user IDs
		let muses: MuseInfo[] = [];
		try {
			// Collect all user IDs (deduplicated) - now from API key
			const userIds = await this.getAllUserIds();
			if (userIds.length === 0) {
				new Notice('Failed to get user ID from API key. Please check your API key in settings.');
				return;
			}

			// Always use user_ids parameter for consistency with API
			const queryParam = `user_ids=${userIds.join(',')}`;

			const url = `${this.getBotApiUrl()}/api/v1/muses/list?${queryParam}`;
			console.log(`[MultimuseObsidian] Fetching muses for ${userIds.length} user(s): ${userIds.join(', ')}`);
			console.log(`[MultimuseObsidian] API URL: ${url}`);

			const response = await requestUrl({
				url: url,
				method: 'GET',
				headers: this.getApiHeaders()
			});

			if (response.status === 200) {
				const data = JSON.parse(response.text);
				muses = data.muses || [];
				console.log(`[MultimuseObsidian] Found ${muses.length} muse(s) from ${userIds.length} user(s)`);
				if (muses.length > 0) {
					const ownerIds = muses.map(m => m.owner_id);
					const uniqueOwners = [...new Set(ownerIds)];
					console.log(`[MultimuseObsidian] Muses from ${uniqueOwners.length} owner(s): ${uniqueOwners.join(', ')}`);
					console.log(`[MultimuseObsidian] Muse names: ${muses.map(m => m.name).join(', ')}`);
				}
			} else {
				if (!this.handleApiError(response, 'createNewScene - fetch muses')) {
					console.error(`[MultimuseObsidian] API error: ${response.status} - ${response.text}`);
					new Notice(`Failed to fetch muses: ${response.status}`);
				}
				return;
			}
		} catch (error) {
			console.error('Error fetching muses:', error);
			new Notice('Failed to fetch muses from bot API. Check your API URL and connection.');
			return;
		}

		if (muses.length === 0) {
			new Notice('No muses found. Make sure you have muses created in Discord.');
			return;
		}

		// 2) Select muse
		const museOptions = muses.map(m => m.name);
		const selectedMuseIndex = await this.showSuggester(museOptions, museOptions);
		if (selectedMuseIndex === null || selectedMuseIndex < 0) return;

		const selectedMuse = muses[selectedMuseIndex];

		// 3) Get Discord thread/channel link
		const threadUrl = await this.showInputPrompt('Enter Discord thread/channel URL');
		if (!threadUrl) return;

		const threadInfo = this.extractThreadInfoFromUrl(threadUrl);
		if (!threadInfo) {
			new Notice('Invalid Discord URL format.');
			return;
		}

		// 4) Get location (RP folder)
		const location = await this.selectSceneLocation();
		if (!location) return;

		// 5) Get scene name
		const sceneName = await this.showInputPrompt('Enter scene name', `${selectedMuse.name} - Scene`);
		if (!sceneName) return;

		// 6) Get participants
		const participantsStr = await this.showInputPrompt('Number of participants (default: 2)', '2');
		const participants = parseInt(participantsStr) || 2;

		// 7) Create scene file
		const filePath = `${location}/${sceneName}.md`;
		const frontmatter = {
			'Link': threadUrl,
			'Characters': [selectedMuse.name],
			'Participants': participants,
			'Replied?': false,
			'Created': new Date().toISOString().split('T')[0],
		};

		const frontmatterLines = ['---'];
		for (const [key, value] of Object.entries(frontmatter)) {
			if (Array.isArray(value)) {
				frontmatterLines.push(`${key}:`);
				for (const item of value) {
					frontmatterLines.push(`  - ${item}`);
				}
			} else {
				frontmatterLines.push(`${key}: ${value}`);
			}
		}
		frontmatterLines.push('---');
		frontmatterLines.push('');

		const content = frontmatterLines.join('\n');

		// Ensure folder exists
		const folderPath = location;
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!folder) {
			await this.app.vault.createFolder(folderPath);
		}

		// Create file
		const createdFile = await this.app.vault.create(filePath, content);

		// 8) Register with bot API and optionally create thread tracking
		try {
			// Register scene
			// Log the extracted thread info for debugging
			console.debug(`Registering scene: threadId=${threadInfo.threadId}, guildId=${threadInfo.guildId}, channelId=${threadInfo.channelId}, url=${threadUrl}`);
			
			// Convert IDs to strings to avoid JavaScript number precision loss
			// Discord IDs are larger than Number.MAX_SAFE_INTEGER, so we send them as strings
			// Use primary user ID for scene registration
			const primaryUserId = await this.getPrimaryUserId();
			if (!primaryUserId) {
				new Notice('Failed to get user ID from API key. Please check your API key in settings.');
				return;
			}
			
			const registerResponse = await requestUrl({
				url: `${this.getBotApiUrl()}/api/v1/scenes/create`,
				method: 'POST',
				headers: this.getApiHeaders(),
				body: JSON.stringify({
					thread_id: threadInfo.threadId,  // Send as string, let Python convert
					user_id: primaryUserId,  // Send as string
					scene_path: createdFile.path,
					characters: [selectedMuse.name],
					participants: participants,
					is_active: true,
					guild_id: threadInfo.guildId || null  // Send as string or null
				})
			});
			
			console.debug(`Scene registration response: ${registerResponse.status} - ${registerResponse.text}`);

			if (registerResponse.status === 200) {
				// Scene registered successfully - proceed with optional operations
				
				// Also create thread tracking (optional - don't fail if this errors)
				// This may fail if bot can't access the thread, which is okay
				try {
					const trackResponse = await requestUrl({
						url: `${this.getBotApiUrl()}/api/v1/threads/track`,
						method: 'POST',
						headers: this.getApiHeaders(),
						body: JSON.stringify({
							thread_id: threadInfo.threadId,  // Send as string to avoid precision loss
							user_id: primaryUserId,  // Send as string
							muse_name: selectedMuse.name,
							participants: participants,
							scene_path: createdFile.path,
							guild_id: threadInfo.guildId || null  // Send as string or null
						})
					});
					
					if (trackResponse.status === 200) {
						console.debug('Thread tracking created successfully');
					} else {
						console.error(`Thread tracking failed: ${trackResponse.status} - ${trackResponse.text}`);
					}
				} catch (trackError: any) {
					// Thread tracking is optional - scene is already registered
					// Only log if it's not a 400 (which means bot can't access thread - expected)
					if (trackError?.status !== 400) {
						console.error('Thread tracking error (non-fatal):', trackError);
					}
				}

				// Add to Base if configured
				try {
					if (this.settings.basePath) {
						await this.addSceneToBase(createdFile, frontmatter);
					}
				} catch (baseError) {
					console.error('Error adding to Base (non-fatal):', baseError);
				}

				new Notice(`Scene created: ${sceneName}`);
				await this.app.workspace.getLeaf(true).openFile(createdFile);
			} else if (registerResponse.status === 401) {
				// Authentication error - show helpful message
				this.handleApiError(registerResponse, 'createNewScene - register scene');
				new Notice('Scene created but failed to register with bot: Authentication failed. Check your API key.');
			} else {
				const errorText = registerResponse.text || 'Unknown error';
				console.error(`Failed to register scene: ${registerResponse.status} - ${errorText}`);
				new Notice(`Scene created but failed to register with bot: ${registerResponse.status}`);
			}
		} catch (error: any) {
			// Log the full error for debugging
			console.error('Error registering scene:', error);
			const errorMessage = error?.message || error?.text || 'Unknown error';
			console.error('Error details:', errorMessage);
			
			// Only show error if scene registration itself failed
			// Thread tracking errors are handled above and shouldn't reach here
			if (error?.status === 400 && error?.message?.includes('threads/track')) {
				// This is a thread tracking error that slipped through - ignore it
				// Scene was already registered successfully
				new Notice(`Scene created: ${sceneName}`);
				await this.app.workspace.getLeaf(true).openFile(createdFile);
			} else {
				new Notice(`Scene created but failed to register with bot: ${errorMessage}`);
			}
		}
	}

	async syncFromTracker(): Promise<void> {
		/**Sync scenes from bot tracker to Obsidian Base and create missing scene files.*/
		if (!this.settings.apiKey) {
			new Notice('API key must be configured in settings.');
			return;
		}

		try {
			// Get primary user ID for tracked threads query
			const primaryUserId = await this.getPrimaryUserId();
			if (!primaryUserId) {
				new Notice('Failed to get user ID from API key. Please check your API key in settings.');
				return;
			}

			// Get tracked threads from bot
			const response = await requestUrl({
				url: `${this.getBotApiUrl()}/api/v1/threads/tracked?user_id=${primaryUserId}`,
				method: 'GET',
				headers: this.getApiHeaders()
			});

			if (response.status !== 200) {
				if (!this.handleApiError(response, 'syncFromTracker - fetch tracked threads')) {
					console.error(`Failed to fetch tracked threads: ${response.status}`);
					new Notice('Failed to fetch tracked threads from bot.');
				}
				return;
			}

			const data = JSON.parse(response.text);
			const threads = data.threads || [];

			if (threads.length === 0) {
				new Notice('No tracked threads found.');
				return;
			}

			let createdCount = 0;
			let updatedCount = 0;

			for (const thread of threads) {
				const threadId = thread.thread_id;
				const museName = thread.muse_name;
				const participants = thread.participants || 2;
				const existingScenePath = thread.scene_path;

				// Check if scene already exists
				if (existingScenePath) {
					const existingFile = this.app.vault.getAbstractFileByPath(existingScenePath);
					if (existingFile && existingFile instanceof TFile) {
						// Update Base if configured
						if (this.settings.basePath) {
							await this.updateBaseRecord(existingFile, thread);
						}
						updatedCount++;
						continue;
					}
				}

				// Create new scene file
				// Only create if we have a valid scene_path (thread is linked to Obsidian)
				// If no scene_path, this thread isn't meant to be an Obsidian scene
				if (!existingScenePath) {
					// Skip threads without scene_path - they're not Obsidian scenes
					continue;
				}
				
				const guildId = thread.guild_id;
				// Don't create URLs with guild_id=0 - that's invalid
				const threadUrl = guildId && guildId !== '0' && guildId !== 0
					? `https://discord.com/channels/${guildId}/${threadId}`
					: null;  // Can't create valid URL without guild_id
				
				if (!threadUrl) {
					console.debug(`Skipping thread ${threadId} - no valid guild_id`);
					continue;
				}

				// Determine location (use scenes folder + default subfolder or prompt)
				const location = await this.selectSceneLocation(`muse "${museName}"`);
				if (!location) continue;

				const sceneName = thread.thread_name || `${museName} - Thread ${threadId}`;
				const filePath = `${location}/${sceneName}.md`;

				const frontmatter = {
					'Link': threadUrl,
					'Characters': [museName],
					'Participants': participants,
					'Replied?': false,
					'Created': new Date().toISOString().split('T')[0],
				};

				const frontmatterLines = ['---'];
				for (const [key, value] of Object.entries(frontmatter)) {
					if (Array.isArray(value)) {
						frontmatterLines.push(`${key}:`);
						for (const item of value) {
							frontmatterLines.push(`  - ${item}`);
						}
					} else {
						frontmatterLines.push(`${key}: ${value}`);
					}
				}
				frontmatterLines.push('---');
				frontmatterLines.push('');

				const content = frontmatterLines.join('\n');

				// Ensure folder exists
				const folder = this.app.vault.getAbstractFileByPath(location);
				if (!folder) {
					await this.app.vault.createFolder(location);
				}

				// Create file
				const file = await this.app.vault.create(filePath, content);

				// Register with bot
				// Use primary user ID for scene registration
				const primaryUserId = await this.getPrimaryUserId();
				if (!primaryUserId) {
					console.error('Failed to get user ID from API key, skipping scene registration');
					continue;
				}
				
				await requestUrl({
					url: `${this.getBotApiUrl()}/api/v1/scenes/create`,
					method: 'POST',
					headers: this.getApiHeaders(),
					body: JSON.stringify({
						thread_id: threadId,  // Send as string to avoid precision loss
						user_id: primaryUserId,  // Send as string
						scene_path: filePath,
						characters: [museName],
						participants: participants,
						guild_id: guildId || null,  // Include guild_id if available
					})
				});

				// Add to Base if configured
				if (this.settings.basePath) {
					await this.addSceneToBase(file, frontmatter);
				}

				createdCount++;
			}

			new Notice(`Sync complete: ${createdCount} created, ${updatedCount} updated`);
		} catch (error) {
			console.error('Error syncing from tracker:', error);
			new Notice('Error syncing from tracker. Check console for details.');
		}
	}

	// ========= BASE INTEGRATION =========

	async addSceneToBase(file: TFile, frontmatter: any): Promise<void> {
		/**Add scene to Obsidian Base with characters as variables.*/
		if (!this.settings.basePath) return;

		try {
			const baseFile = this.app.vault.getAbstractFileByPath(this.settings.basePath);
			if (!baseFile || !(baseFile instanceof TFile)) {
				return;
			}

			// Skip .base files - they use a special format that we shouldn't modify directly
			// Base plugin should handle its own format
			if (baseFile.extension === 'base') {
				console.log(`[MultimuseObsidian] Skipping Base integration for .base file - use Base plugin UI to add records`);
				return;
			}

			// Only handle .md files with markdown tables
			if (baseFile.extension !== 'md') {
				return;
			}

			// Read Base file
			const baseContent = await this.app.vault.read(baseFile);
			
			// Extract characters from frontmatter
			const characters = this.getCharacterNames(frontmatter);
			const link = frontmatter['Link'] || '';
			const participants = frontmatter['Participants'] || 2;
			const replied = frontmatter['Replied?'] || false;

			// Check if scene already exists in table
			if (baseContent.includes(`| ${file.basename} |`)) {
				// Scene already exists, skip
				return;
			}

			// Add record as markdown table row
			const recordLine = `| ${file.basename} | ${characters.join(', ')} | ${link} | ${participants} | ${replied} |\n`;
			
			// Check if Base has table structure
			if (baseContent.includes('|')) {
				// Append to existing table
				await this.app.vault.modify(baseFile, baseContent + recordLine);
			} else {
				// Create table structure
				const tableHeader = '| Scene | Characters | Link | Participants | Replied? |\n|-------|------------|------|--------------|----------|\n';
				await this.app.vault.modify(baseFile, tableHeader + recordLine);
			}
		} catch (error) {
			console.error('Error adding scene to Base:', error);
		}
	}

	async updateBaseRecord(file: TFile, thread: any): Promise<void> {
		/**Update existing Base record for a scene.*/
		if (!this.settings.basePath) return;

		try {
			const baseFile = this.app.vault.getAbstractFileByPath(this.settings.basePath);
			if (!baseFile || !(baseFile instanceof TFile)) return;

			// Skip .base files - they use a special format
			if (baseFile.extension === 'base') {
				return;
			}

			// Only handle .md files
			if (baseFile.extension !== 'md') {
				return;
			}

			const baseContent = await this.app.vault.read(baseFile);
			const sceneName = file.basename;

			// Update the row for this scene
			const lines = baseContent.split('\n');
			const updatedLines = lines.map(line => {
				if (line.includes(`| ${sceneName} |`)) {
					const characters = [thread.muse_name];
					const link = thread.guild_id && thread.guild_id !== '0'
						? `https://discord.com/channels/${thread.guild_id}/${thread.thread_id}`
						: `https://discord.com/channels/0/${thread.thread_id}`;
					return `| ${sceneName} | ${characters.join(', ')} | ${link} | ${thread.participants || 2} | false |`;
				}
				return line;
			});

			await this.app.vault.modify(baseFile, updatedLines.join('\n'));
		} catch (error) {
			console.error('Error updating Base record:', error);
		}
	}

	// ========= HELPER METHODS =========

	extractThreadInfoFromUrl(url: string): { threadId: string; guildId: string | null; channelId?: string } | null {
		// Discord URL formats:
		// Thread in channel: https://discord.com/channels/GUILD_ID/CHANNEL_ID/THREAD_ID
		// Standalone thread: https://discord.com/channels/GUILD_ID/THREAD_ID (thread ID = channel ID)
		const match3 = url.match(/discord(?:app)?(?:canary)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
		if (match3) {
			// 3-part URL: GUILD_ID/CHANNEL_ID/THREAD_ID - thread ID is the last one
			return { guildId: match3[1], channelId: match3[2], threadId: match3[3] };
		}
		
		const match2 = url.match(/discord(?:app)?(?:canary)?\.com\/channels\/(\d+)\/(\d+)/);
		if (match2) {
			// 2-part URL: GUILD_ID/THREAD_ID - could be a standalone thread or channel
			// In this case, the thread ID is the same as the channel ID
			return { guildId: match2[1], threadId: match2[2] };
		}
		
		return null;
	}

	async selectSceneLocation(context?: string): Promise<string | null> {
		/**Select or create scene location folder.
		 * @param context Optional context string (e.g., muse name) to display in the prompt
		 */
		const RP_ROOT = this.settings.scenesFolder;
		const files = this.app.vault.getFiles();
		const dirSet = new Set<string>();

		for (const file of files) {
			if (!file.path.startsWith(RP_ROOT + "/")) continue;
			const parts = file.path.split("/");
			parts.pop();
			if (parts.length >= 2) {
				for (let i = 2; i <= parts.length; i++) {
					const dirPath = parts.slice(0, i).join("/");
					dirSet.add(dirPath);
				}
			}
		}

		let options = Array.from(dirSet)
			.map((fullPath) => fullPath.slice(RP_ROOT.length + 1))
			.filter(Boolean)
			.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));

		options.push("+ New folder path…");

		// Build title with context if provided
		const suggesterTitle = context 
			? `Select location for ${context}`
			: 'Select scene location';
		
		const choiceIndex = await this.showSuggester(options, options, suggesterTitle);
		if (choiceIndex === null) return null;

		const choice = options[choiceIndex];
		if (!choice) return null;

		let relPath: string;
		if (choice === "+ New folder path…") {
			const promptMsg = context
				? `Folder under "${RP_ROOT}" for ${context} (e.g. For the Greeks/Twin Flames)`
				: `Folder under "${RP_ROOT}" (e.g. For the Greeks/Twin Flames)`;
			const input = await this.showInputPrompt(promptMsg);
			if (!input) return null;
			relPath = input.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
		} else {
			relPath = choice;
		}

		return `${RP_ROOT}/${relPath}`;
	}

	showSuggester(items: string[], values: any[], title?: string): Promise<number | null> {
		return new Promise((resolve) => {
			// Create a modal with buttons
			const modal = new (class extends Modal {
				selectedIndex: number | null = null;
				items: string[];
				values: any[];
				titleText: string;

				constructor(app: App, items: string[], values: any[], titleText?: string) {
					super(app);
					this.items = items;
					this.values = values;
					this.titleText = titleText || 'Select an option';
					// Set title in constructor to ensure it's set before modal opens
					this.titleEl.textContent = this.titleText;
				}

				onOpen() {
					const { contentEl } = this;
					contentEl.empty();
					
					// Ensure title is set (in case it was reset)
					this.titleEl.textContent = this.titleText;
					
					// If title contains context (e.g., "for muse X"), extract and display prominently
					if (this.titleText.includes('for')) {
						// Extract the muse name from the title
						const match = this.titleText.match(/for (.+)$/);
						if (match) {
							const contextInfo = match[1];
							const infoEl = contentEl.createEl('div', {
								attr: { 
									style: 'margin-bottom: 20px; padding: 10px; background: var(--background-modifier-border); border-radius: 4px;' 
								}
							});
							infoEl.createEl('strong', { 
								text: `Creating scene file for: ${contextInfo}`,
								attr: { style: 'color: var(--text-normal); font-size: 1.1em;' }
							});
						}
						const descEl = contentEl.createEl('p', {
							text: 'Choose where to create the scene file:',
							attr: { style: 'margin-top: 10px; margin-bottom: 15px; color: var(--text-muted);' }
						});
					}

					this.items.forEach((item, index) => {
						const button = contentEl.createEl('button', {
							text: item,
							cls: 'mod-cta',
							attr: { style: 'width: 100%; margin: 5px 0;' }
						});
						button.onclick = () => {
							this.selectedIndex = index;
							this.close();
						};
					});
				}

				onClose() {
					resolve(this.selectedIndex);
				}
			})(this.app, items, values, title);

			modal.open();
		});
	}

	showInputPrompt(prompt: string, defaultValue?: string): Promise<string | null> {
		return new Promise((resolve) => {
			// Use Obsidian's built-in modal for input
			const modal = new (class extends Modal {
				inputEl: HTMLInputElement;
				value: string | null = null;

				constructor(app: App, prompt: string, defaultValue?: string) {
					super(app);
					this.titleEl.textContent = prompt;
					this.inputEl = this.contentEl.createEl('input', {
						type: 'text',
						value: defaultValue || ''
					});
					this.inputEl.style.width = '100%';
					this.inputEl.onkeydown = (e) => {
						if (e.key === 'Enter') {
							this.value = this.inputEl.value;
							this.close();
						}
					};
				}

				onOpen() {
					this.inputEl.focus();
					this.inputEl.select();
				}

				onClose() {
					resolve(this.value);
				}
			})(this.app, prompt, defaultValue);

			modal.open();
		});
	}

	async sendSelectionAsMuse(editor: Editor, view: MarkdownView): Promise<void> {
		/**Send selected text as a muse to Discord thread from frontmatter properties.*/
		// Get selected text
		const selection = editor.getSelection();
		if (!selection || selection.trim().length === 0) {
			new Notice('No text selected. Please select text to send as muse.');
			return;
		}

		// Get active file
		const file = view.file;
		if (!file) {
			new Notice('No active file found.');
			return;
		}

		// Get frontmatter
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache || !cache.frontmatter) {
			new Notice('File does not have frontmatter. Please add Link and Characters properties.');
			return;
		}

		// Extract link and characters
		const link = cache.frontmatter['Link'];
		if (!link) {
			new Notice('No Link property found in frontmatter. Please add a Discord thread URL.');
			return;
		}

		const characters = this.getCharacterNames(cache.frontmatter);
		if (characters.length === 0) {
			new Notice('No Characters property found in frontmatter. Please add at least one character name.');
			return;
		}

		// Extract thread ID from link
		const threadId = this.extractThreadIdFromUrl(link);
		if (!threadId) {
			new Notice('Invalid Discord URL format in Link property.');
			return;
		}

		// Get primary user ID
		const primaryUserId = await this.getPrimaryUserId();
		if (!primaryUserId) {
			new Notice('Failed to get user ID from API key. Please check your API key in settings.');
			return;
		}

		// Select muse if multiple characters
		let selectedMuse: string;
		if (characters.length === 1) {
			selectedMuse = characters[0];
		} else {
			// Show modal to select muse
			const museIndex = await this.showSuggester(characters, characters);
			if (museIndex === null || museIndex < 0) {
				return; // User cancelled
			}
			selectedMuse = characters[museIndex];
		}

		// Verify muse exists and is accessible
		const userIds = await this.getAllUserIds();
		if (userIds.length === 0) {
			new Notice('Failed to get user ID from API key. Please check your API key in settings.');
			return;
		}

		// Get muses to verify the selected muse is available
		let muses: MuseInfo[] = [];
		try {
			const queryParam = `user_ids=${userIds.join(',')}`;
			const url = `${this.getBotApiUrl()}/api/v1/muses/list?${queryParam}`;
			const response = await requestUrl({
				url: url,
				method: 'GET',
				headers: this.getApiHeaders()
			});

			if (response.status === 200) {
				const data = JSON.parse(response.text);
				muses = data.muses || [];
			} else {
				if (!this.handleApiError(response, 'sendSelectionAsMuse - fetch muses')) {
					new Notice(`Failed to fetch muses: ${response.status}`);
				}
				return;
			}
		} catch (error) {
			console.error('Error fetching muses:', error);
			new Notice('Failed to fetch muses from bot API. Check your API URL and connection.');
			return;
		}

		// Check if selected muse exists (case-insensitive fuzzy match)
		const museExists = muses.some(m => {
			const museLower = m.name.toLowerCase().trim();
			const selectedLower = selectedMuse.toLowerCase().trim();
			// Exact match or contains check
			return museLower === selectedLower || museLower.includes(selectedLower) || selectedLower.includes(museLower);
		});

		if (!museExists) {
			new Notice(`Muse "${selectedMuse}" not found or not accessible. Available muses: ${muses.map(m => m.name).join(', ')}`);
			return;
		}

		// Post message via API
		try {
			const url = `${this.getBotApiUrl()}/api/v1/messages/post`;
			const response = await requestUrl({
				url: url,
				method: 'POST',
				headers: this.getApiHeaders(),
				body: JSON.stringify({
					thread_id: threadId,
					muse_name: selectedMuse,
					content: selection.trim(),
					user_id: primaryUserId
				})
			});

			if (response.status === 200) {
				const data = JSON.parse(response.text);
				new Notice(`Message sent as ${selectedMuse}!`);
			} else {
				if (!this.handleApiError(response, 'sendSelectionAsMuse - post message')) {
					const errorData = JSON.parse(response.text);
					new Notice(`Failed to send message: ${errorData.message || response.status}`);
				}
			}
		} catch (error: any) {
			console.error('Error sending message:', error);
			const errorMessage = error?.message || error?.text || 'Unknown error';
			new Notice(`Failed to send message: ${errorMessage}`);
		}
	}
}

class MultimuseObsidianSettingTab extends PluginSettingTab {
	plugin: MultimuseObsidian;

	constructor(app: App, plugin: MultimuseObsidian) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Multimuse Obsidian Settings' });

		// Enable/Disable toggle
		new Setting(containerEl)
			.setName('Enable Polling')
			.setDesc('Automatically check Discord threads for new replies')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enabled)
				.onChange(async (value) => {
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
					if (value) {
						this.plugin.startPolling();
					} else {
						this.plugin.stopPolling();
					}
				}));

		// Poll Interval
		new Setting(containerEl)
			.setName('Poll Interval (minutes)')
			.setDesc('How often to check for new replies')
			.addSlider(slider => slider
				.setLimits(5, 60, 5)
				.setValue(this.plugin.settings.pollInterval)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.pollInterval = value;
					await this.plugin.saveSettings();
					if (this.plugin.settings.enabled) {
						this.plugin.stopPolling();
						this.plugin.startPolling();
					}
				}));

		// Scenes Folder
		new Setting(containerEl)
			.setName('Scenes Folder')
			.setDesc('Folder containing your scene files')
			.addText(text => text
				.setPlaceholder('RP Scenes')
				.setValue(this.plugin.settings.scenesFolder)
				.onChange(async (value) => {
					this.plugin.settings.scenesFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Obsidian Base Path')
			.setDesc('Path to your Obsidian Base file (e.g., "RP Scenes/Roleplay Tracker.base" or "RP Scenes/Tracker.md")')
			.addText(text => text
				.setPlaceholder('RP Scenes/Roleplay Tracker.base')
				.setValue(this.plugin.settings.basePath)
				.onChange(async (value) => {
					this.plugin.settings.basePath = value;
					await this.plugin.saveSettings();
				}));

		// Bot API URL - Hidden from user for security (uses hardcoded default)
		// Removed from settings UI to prevent exposing server IP address

		// API Key (required for authentication)
		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Your Multimuse API key for authentication. Generate one using /api generate in Discord DMs with the bot. Your user ID will be automatically detected from the API key.')
			.addText(text => {
				text.setPlaceholder('mm_...')
					.setValue(this.plugin.settings.apiKey || '')
					.inputEl.type = 'password';
				text.onChange(async (value) => {
					this.plugin.settings.apiKey = value.trim();
					// Clear cached user ID when API key changes
					this.plugin.settings.cachedUserId = '';
					await this.plugin.saveSettings();
					
					// Auto-fetch user ID from API key
					if (value.trim()) {
						const userId = await this.plugin.getUserIdFromApiKey();
						if (userId) {
							new Notice(`User ID detected: ${userId}`);
							await this.plugin.syncMuses();
							if (this.plugin.settings.enabled) {
								this.plugin.stopPolling();
								this.plugin.startPolling();
							}
						} else {
							new Notice('Failed to get user ID from API key. Please check your API key.');
						}
					}
				});
			});

		// Show cached user ID (read-only, for information)
		if (this.plugin.settings.cachedUserId) {
			new Setting(containerEl)
				.setName('Detected User ID')
				.setDesc(`Your Discord user ID (automatically detected from API key): ${this.plugin.settings.cachedUserId}`)
				.addText(text => {
					text.setValue(this.plugin.settings.cachedUserId)
						.setDisabled(true);
				});
		}

		// Sync Muses button
		new Setting(containerEl)
			.setName('Sync Muses')
			.setDesc('Manually sync muse names from bot API')
			.addButton(button => button
				.setButtonText('Sync Now')
				.setCta()
				.onClick(async () => {
					await this.plugin.syncMuses();
					new Notice('Muses synced!');
				}));

		// Manual check button
		new Setting(containerEl)
			.setName('Manual Check')
			.setDesc('Check Discord threads now')
			.addButton(button => button
				.setButtonText('Check Now')
				.setCta()
				.onClick(() => {
					this.plugin.checkAllThreads();
					new Notice('Checking Discord threads...');
				}));

		// Info section
		containerEl.createEl('hr');
		const infoEl = containerEl.createEl('div');
		infoEl.createEl('h3', { text: 'How It Works' });
		infoEl.createEl('p', { text: 'This plugin queries the Multimuse API to check if your scene files match tracked threads and updates the "Replied?" and "Participants" fields.' });
		infoEl.createEl('p', { text: '• Scenes are matched by Link (thread_id) and Characters properties' });
		infoEl.createEl('p', { text: '• If scene matches a tracked thread: Updates Replied? (true = your turn, false = not your turn) and Participants' });
		infoEl.createEl('p', { text: '• If scene does not match: No updates (scene is not tracked)' });
		infoEl.createEl('p', { text: '• Make sure your scene files have a "Link" field (Discord thread URL) and "Characters" field (array) in frontmatter' });
		infoEl.createEl('p', { text: '• Uses Multimuse API - requires an API key for authentication' });
		infoEl.createEl('p', { text: '• Generate an API key using /api generate in Discord DMs with the bot' });
		infoEl.createEl('p', { text: '• Scenes are auto-detected when queried - no manual registration needed' });
	}
}

