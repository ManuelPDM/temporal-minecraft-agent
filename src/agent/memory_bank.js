import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';

export class MemoryBank {
	constructor() {
		this.memory = {};
	}


	/**
	 * Save memory bank to disk for persistence across sessions.
	 * @param {string} agentName - The name of the agent (used in file path)
	 * @returns {boolean} true if save was successful, false otherwise
	 */
	save(agentName) {
		try {
			const dir = `./bots/${agentName}`;
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			const path = `${dir}/memory_bank.json`;
			writeFileSync(path, JSON.stringify(this.memory, null, 2));
			return true;
		} catch (err) {
			console.error('Failed to save memory bank:', err);
			return false;
		}
	}

	/**
	 * Load memory bank from disk.
	 * @param {string} agentName - The name of the agent (used in file path)
	 * @returns {boolean} true if load was successful, false otherwise
	 */
	load(agentName) {
		try {
			const dir = `./bots/${agentName}`;
			if (!existsSync(dir)) {
				return false; // No existing data
			}
			const path = `${dir}/memory_bank.json`;
			if (!existsSync(path)) {
				return false;
			}
			const data = JSON.parse(readFileSync(path, 'utf8'));
			this.memory = data;
			return true;
		} catch (err) {
			console.error('Failed to load memory bank:', err);
			return false;
		}
	}


	/**
	 * Remember a location by name with optional metadata.
	 * @param {string} name - The name to identify this location
	 * @param {number} x - X coordinate
	 * @param {number} y - Y coordinate
	 * @param {number} z - Z coordinate
	 * @param {object} metadata - Optional additional data (e.g., dimension, timestamp)
	 */
	rememberPlace(name, x, y, z, metadata = {}) {
		this.memory[name] = {
			type: 'location',
			position: { x, y, z },
			metadata: metadata,
			savedAt: Date.now()
		};
	}

	/**
	 * Recall a saved location by name.
	 * @param {string} name - The name of the location to recall
	 * @returns {{x: number, y: number, z: number, metadata: object}|undefined} Location data or undefined if not found
	 */
	recallPlace(name) {
		const loc = this.memory[name];
		if (loc && loc.type === 'location') {
			return {
				x: loc.position.x,
				y: loc.position.y,
				z: loc.position.z,
				metadata: loc.metadata || {}
			};
		}
		// Fallback for legacy [x, y, z] array format
		if (Array.isArray(loc) && loc.length === 3) {
			return { x: loc[0], y: loc[1], z: loc[2], metadata: {} };
		}
		return undefined;
	}

	/**
	 * Register a new chest with known contents.
	 * @param {string} id - Unique identifier for this chest
	 * @param {number} x - X coordinate
	 * @param {number} y - Y coordinate
	 * @param {number} z - Z coordinate
	 * @param {object} initialContents - Object mapping item names to counts (optional)
	 */
	rememberChest(id, x, y, z, initialContents = {}) {
		this.memory[id] = {
			type: 'chest',
			position: { x, y, z },
			contents: { ...initialContents },
			lastUpdated: Date.now(),
			accessCount: 0
		};
	}

	/**
	 * Update stored contents for a chest.
	 * @param {string} id - Chest identifier
	 * @param {object} newContents - Object mapping item names to counts
	 */
	updateChestContents(id, newContents) {
		if (this.memory[id] && this.memory[id].type === 'chest') {
			this.memory[id].contents = { ...newContents };
			this.memory[id].lastUpdated = Date.now();
			this.memory[id].accessCount++;
		}
	}

	/**
	 * Get full chest data including position and contents.
	 * @param {string} id - Chest identifier
	 * @returns {{position: {x,y,z}, contents: object, lastUpdated: number, accessCount: number}|undefined}
	 */
	recallChest(id) {
		const chest = this.memory[id];
		if (chest && chest.type === 'chest') {
			return {
				position: chest.position,
				contents: chest.contents,
				lastUpdated: chest.lastUpdated,
				accessCount: chest.accessCount
			};
		}
		return undefined;
	}

	/**
	 * Remove a chest from memory.
	 * @param {string} id - Chest identifier to forget
	 */
	forgetChest(id) {
		delete this.memory[id];
	}

	/**
	 * Record a resource location (e.g., forest, ore deposit).
	 * @param {string} type - Resource type (e.g., 'oak_forest', 'iron_ore')
	 * @param {number} x - X coordinate
	 * @param {number} y - Y coordinate
	 * @param {number} z - Z coordinate
	 * @param {object} metadata - Optional metadata (reliability score, etc.)
	 */
	cacheResourceLocation(type, x, y, z, metadata = {}) {
		this.memory[type] = {
			type: 'resource_cache',
			resourceType: type,
			position: { x, y, z },
			lastVisited: Date.now(),
			metadata: metadata
		};
	}

	/**
	 * Get the most recent known location for a resource type.
	 * @param {string} type - Resource type to look up
	 * @returns {{position: {x,y,z}, lastVisited: number, metadata: object}|undefined}
	 */
	recallResourceCache(type) {
		const cache = this.memory[type];
		if (cache && cache.type === 'resource_cache') {
			return {
				position: cache.position,
				lastVisited: cache.lastVisited,
				metadata: cache.metadata || {}
			};
		}
		return undefined;
	}

	/**
	 * Record a dangerous area (mob spawns, lava, etc.).
	 * @param {string} type - Danger type (e.g., 'mob_spawns', 'lava_pool')
	 * @param {number} x - X coordinate
	 * @param {number} y - Y coordinate
	 * @param {number} z - Z coordinate
	 * @param {string} riskLevel - Risk level: 'low', 'medium', or 'high'
	 */
	recordDangerZone(type, x, y, z, riskLevel = 'medium') {
		this.memory[type] = {
			type: 'danger_zone',
			zoneType: type,
			position: { x, y, z },
			riskLevel: riskLevel,
			recordedAt: Date.now()
		};
	}

	/**
	 * Get danger zones within a radius of current position.
	 * @param {object} currentPosition - Current {x, y, z} position
	 * @param {number} radius - Search radius in blocks
	 * @returns {Array<{position: {x,y,z}, zoneType: string, riskLevel: string}>}
	 */
	getDangerZonesNearby(currentPosition, radius = 64) {
		const nearby = [];
		for (const [key, data] of Object.entries(this.memory)) {
			if (data.type === 'danger_zone') {
				const dx = Math.abs(data.position.x - currentPosition.x);
				const dy = Math.abs(data.position.y - currentPosition.y);
				const dz = Math.abs(data.position.z - currentPosition.z);
				// Simple bounding box check (can be improved with Euclidean distance)
				if (dx <= radius && dy <= radius && dz <= radius) {
					nearby.push({
						position: data.position,
						zoneType: data.zoneType,
						riskLevel: data.riskLevel
					});
				}
			}
		}
		return nearby;
	}

	/**
	 * Log a tool execution for usage tracking.
	 * @param {string} toolName - Name of the tool used
	 * @param {boolean} success - Whether the tool succeeded
	 * @param {number} duration - Execution duration in milliseconds
	 * @param {object} context - Additional context about the execution
	 */
	logToolUsage(toolName, success, duration, context = {}) {
		if (!this.memory[toolName]) {
			this.memory[toolName] = {
				type: 'tool_usage',
				name: toolName,
				timesUsed: 0,
				totalDuration: 0,
				successCount: 0,
				failures: []
			};
		}
		const stats = this.memory[toolName];
		stats.timesUsed++;
		stats.totalDuration += duration;
		if (success) {
			stats.successCount++;
		} else {
			stats.failures.push({ timestamp: Date.now(), ...context });
		}
		stats.lastUsed = Date.now();
	}

	/**
	 * Get usage statistics for a tool.
	 * @param {string} toolName - Tool name to look up
	 * @returns {{timesUsed: number, avgDuration: number, successRate: number, lastUsed: number}|undefined}
	 */
	getToolStats(toolName) {
		const stats = this.memory[toolName];
		if (stats && stats.type === 'tool_usage') {
			return {
				timesUsed: stats.timesUsed,
				avgDuration: stats.timesUsed > 0 ? Math.round(stats.totalDuration / stats.timesUsed) : 0,
				successRate: stats.timesUsed > 0 ? stats.successCount / stats.timesUsed : 0,
				lastUsed: stats.lastUsed
			};
		}
		return undefined;
	}

	// ========== Legacy Compatibility Methods ==========

	getJson() {
		return this.memory;
	}

	loadJson(json) {
		this.memory = json;
	}

	getKeys() {
		return Object.keys(this.memory).join(', ');
	}
}