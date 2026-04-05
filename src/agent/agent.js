import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;
        this._msgQueue = Promise.resolve();
        this._msgQueueDepth = 0;

        // Initialize components
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.self_prompter = new SelfPrompter(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions ||[]);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);
        
        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;
            if (this.temporalWorkflowHandle) {
                this.temporalWorkflowHandle.signal('agentDisconnected').catch(() => {});
            }
            const { type } = handleDisconnection(this.name, reason);
            process.exit(1);
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        initModes(this);

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();
            
            // --- ANTI-NAN CRASH SAFEGUARD ---
            let lastGoodState = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }; // Added yaw and pitch

            const originalWrite = this.bot._client.write.bind(this.bot._client);
            this.bot._client.write = (name, params) => {
                if (name === 'position' || name === 'position_look' || name === 'look') {
                    const hasNaN = (
                        (params.x !== undefined && isNaN(params.x)) ||
                        (params.y !== undefined && isNaN(params.y)) ||
                        (params.z !== undefined && isNaN(params.z)) ||
                        (params.yaw !== undefined && isNaN(params.yaw)) ||
                        (params.pitch !== undefined && isNaN(params.pitch))
                    );

                    if (hasNaN) {
                        // Cure the NaN infection by reverting BOTH position and camera angles!
                        if (this.bot.entity) {
                            if (this.bot.entity.velocity) {
                                this.bot.entity.velocity.set(0, 0, 0); 
                            }
                            if (this.bot.entity.position) {
                                this.bot.entity.position.set(lastGoodState.x, lastGoodState.y, lastGoodState.z);
                            }
                            // Snap the camera back to reality
                            this.bot.entity.yaw = lastGoodState.yaw;
                            this.bot.entity.pitch = lastGoodState.pitch;
                        }
                        return; // Abort sending the illegal packet!
                    } else {
                        // If the math is good, save this location and camera angle as our backup!
                        if (this.bot.entity) {
                            if (this.bot.entity.position && !isNaN(this.bot.entity.position.x)) {
                                lastGoodState.x = this.bot.entity.position.x;
                                lastGoodState.y = this.bot.entity.position.y;
                                lastGoodState.z = this.bot.entity.position.z;
                            }
                            if (!isNaN(this.bot.entity.yaw) && !isNaN(this.bot.entity.pitch)) {
                                lastGoodState.yaw = this.bot.entity.yaw;
                                lastGoodState.pitch = this.bot.entity.pitch;
                            }
                        }
                    }
                }
                originalWrite(name, params);
            };

            // --- SAFE LOOKAT WRAPPER ---
            // Prevents math crashes when target hitbox overlaps bot
            const originalLookAt = this.bot.lookAt.bind(this.bot);
            this.bot.lookAt = async (point, force) => {
                if (!point || isNaN(point.x) || isNaN(point.y) || isNaN(point.z)) return;
                try {
                    await originalLookAt(point, force);
                } catch (err) {
                    // Silently ignore impossible geometry math
                }
            };
            // -------------------------------------------------

            // Set skin for profile
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.bot.chat(`/skin clear`);
            if (this.temporalWorkflowHandle) {
                this.temporalWorkflowHandle.signal('agentConnected').catch(() => {});
            }
        });

		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);

        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();
              
                this._setupEventHandlers(save_data, init_message);
                this.startEvents();
                if (this.temporalWorkflowHandle) {
                    this.temporalWorkflowHandle.signal('agentSpawned').catch(() => {});
                }
              
                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages =[
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message) => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.handleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);
        
        this.bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            respondFunc(username, message);
        });

        // Set up auto-eat
        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood:["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            await this.handleMessage('system', init_message, 2);
        }
        else {
            this.openChat("Hello world! I am "+this.name);
        }
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        try { this.bot.collectBlock.cancelTask(); } catch (e) {}
        try { if (this.bot.pathfinder) this.bot.pathfinder.setGoal(null); } catch (e) {}
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    handleMessage(source, message, max_responses=null) {
        this._msgQueueDepth++;
        const resultPromise = this._msgQueue
            .catch(() => {})
            .then(() => this._handleMessageImpl(source, message, max_responses))
            .finally(() => { this._msgQueueDepth--; });
        this._msgQueue = resultPromise.catch(() => {});
        return resultPromise;
    }

    async _handleMessageImpl(source, message, max_responses=null) {
        this._lastExecutedCommand = null;
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        if (!self_prompt && !from_other_bot) {
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message);
                if (execute_res) 
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        await this.history.add(source, message);
        this.history.save();

        if (!self_prompt && this.self_prompter.isActive()) 
            max_responses = 1; 

        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            let res = await this.prompter.promptConvo(history);

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response')
                break;
            }

            let command_name = containsCommand(res);

            if (command_name) {
                res = truncCommandMessage(res); 
                this.history.add(this.name, res);
                
                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    console.warn('Agent hallucinated command:', command_name)
                    continue;
                }

                if (checkInterrupt()) break;
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.show_command_syntax === "full") {
                    this.routeResponse(source, res);
                }
                else if (settings.show_command_syntax === "shortened") {
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }
                else {
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    if (pre_message.trim().length > 0)
                        this.routeResponse(source, pre_message);
                }

                this._currentCommand = res; // visible to Temporal heartbeat while running
                let execute_res = await executeCommand(this, res);
                this._currentCommand = null;
                this._lastExecutedCommand = res;

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                if (execute_res)
                    this.history.add('system', execute_res);
                else
                    break;
            }
            else { 
                this.history.add(this.name, res);
                this.routeResponse(source, res);
                break;
            }
            
            this.history.save();
        }

        return used_command;
    }

    async handlePassiveThinking() {
        if (this._msgQueueDepth > 0) return;
        this._msgQueue = this._msgQueue.then(() =>
            this.prompter.promptPassiveThinking(this.history.getHistory(), this.history.memory)
                .then(({ memoryUpdate, turnsToRemove }) => {
                    if (memoryUpdate) this.history.memory = memoryUpdate;
                    if (turnsToRemove && turnsToRemove.length > 0) {
                        const sorted = [...turnsToRemove].sort((a, b) => b - a);
                        for (const idx of sorted) {
                            if (idx >= 0 && idx < this.history.turns.length) {
                                this.history.turns.splice(idx, 1);
                            }
                        }
                    }
                    this.history.save();
                })
                .catch(err => console.warn('[PassiveThinking] Error:', err))
        );
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            convoManager.sendToBot(to_player, message);
        }
        else {
            this.openChat(message);
        }
    }

    async openChat(message) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) {
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
        }
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0) this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000) this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000) this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000) this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        let knockbackRecoveryTimeout = null;

        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
                
                if (knockbackRecoveryTimeout) {
                    clearTimeout(knockbackRecoveryTimeout);
                }
                
                // Graceful pathfinder shutdown to prevent "PathStopped" exception
                if (this.bot.pathfinder && this.bot.pathfinder.isMoving()) {
                    try { this.bot.pathfinder.setGoal(null); } catch (e) {}
                }
                this.bot.clearControlStates();
                
                // Instant cure for corrupted velocity
                if (this.bot.entity && this.bot.entity.velocity) {
                    if (isNaN(this.bot.entity.velocity.x)) {
                        this.bot.entity.velocity.set(0, 0, 0);
                    }
                }
                
                knockbackRecoveryTimeout = setTimeout(() => {
                    knockbackRecoveryTimeout = null;
                }, 500); 
            }
            prev_health = this.bot.health;
        });

        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });

        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });

        this.bot.on('death', () => {
            this.actions.cancelResume();
            this.actions.stop();
        });

        this.bot.on('kicked', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });

        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                
                // Fallback to safe coordinates if physics engine broke at exact moment of death
                if (!death_pos || isNaN(death_pos.x) || isNaN(death_pos.y) || isNaN(death_pos.z)) {
                    death_pos = { x: 0, y: 64, z: 0 };
                }
                
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                let dimention = this.bot.game.dimension;
                
                this.handleMessage('system', `You died at position ${death_pos_text} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`);
            }
        });

        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            // Graceful shutdown on idle
            try { 
                if (this.bot.pathfinder && this.bot.pathfinder.isMoving()) {
                    this.bot.pathfinder.setGoal(null);
                } else if (this.bot.pathfinder) {
                    this.bot.pathfinder.stop(); 
                }
            } catch (e) {}

            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }

    cleanKill(msg='Killing agent process...', code=1) {
        this.history.add('system', msg);
        this.bot.chat(code > 1 ? 'Restarting.': 'Exiting.');
        this.history.save();
        if (this.temporalWorkflowHandle) {
            this.temporalWorkflowHandle.signal('shutdown').catch(() => {});
        }
        process.exit(code);
    }
    
    async checkTaskDone() {
        if (this.task && this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                console.log('Task finished:', res.message);
                if (this.temporalWorkflowHandle) {
                    await this.temporalWorkflowHandle.signal('taskCompleted', { score: res.score, message: res.message }).catch(() => {});
                }
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}