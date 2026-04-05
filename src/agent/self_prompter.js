const STOPPED = 0
const ACTIVE = 1
const PAUSED = 2
export class SelfPrompter {
    constructor(agent) {
        this.agent = agent;
        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.prompt = '';
        this.idle_time = 0;
        this.cooldown = 2000;
        this._goalPaused = false; // true while Temporal GoalPursuit is paused (mode running)
    }

    start(prompt) {
        console.log('Self-prompting started.');
        if (!prompt) {
            if (!this.prompt)
                return 'No prompt specified. Ignoring request.';
            prompt = this.prompt;
        }
        this.state = ACTIVE;
        this.prompt = prompt;
        this.startLoop();
    }

    isActive() {
        return this.state === ACTIVE;
    }

    isStopped() {
        return this.state === STOPPED;
    }

    isPaused() {
        return this.state === PAUSED;
    }

    async handleLoad(prompt, state) {
        if (state == undefined)
            state = STOPPED;
        this.state = state;
        this.prompt = prompt;
        if (state !== STOPPED && !prompt)
            throw new Error('No prompt loaded when self-prompting is active');
        if (state === ACTIVE) {
            await this.start(prompt);
        }
    }

    setPromptPaused(prompt) {
        this.prompt = prompt;
        this.state = PAUSED;
    }

    async startLoop() {
        if (this.loop_active) {
            // If Temporal's GoalPursuit is paused (e.g. mode was running), resume it
            if (this.agent.temporalWorkflowHandle && this._goalPaused) {
                this._goalPaused = false;
                this.interrupt = false; // clear any stale interrupt before resuming
                await this.agent.temporalWorkflowHandle
                    .signal('resumeGoalPursuit')
                    .catch(err => console.warn('[Temporal] resumeGoalPursuit signal failed:', err));
            } else {
                console.warn('Self-prompt loop is already active. Ignoring request.');
            }
            return;
        }
        console.log('starting self-prompt loop')
        this.loop_active = true;

        // Delegate to Temporal GoalPursuitWorkflow when available
        if (this.agent.temporalWorkflowHandle) {
            this._goalPaused = false;
            this.interrupt = false; // ensure any stale interrupt flag is cleared before Temporal takes over
            await this.agent.temporalWorkflowHandle
                .signal('startGoalPursuit', { goalId: 'self_prompt', description: this.prompt })
                .catch(err => console.warn('[Temporal] startGoalPursuit signal failed:', err));
            return;
        }

        let no_command_count = 0;
        const MAX_NO_COMMAND = 3;
        while (!this.interrupt) {
            const msg = `You are self-prompting with the goal: '${this.prompt}'. Your next response MUST contain a command with this syntax: !commandName. Respond:`;
            
            let used_command = await this.agent.handleMessage('system', msg, -1);
            if (!used_command) {
                no_command_count++;
                if (no_command_count >= MAX_NO_COMMAND) {
                    let out = `Agent did not use command in the last ${MAX_NO_COMMAND} auto-prompts. Stopping auto-prompting.`;
                    this.agent.openChat(out);
                    console.warn(out);
                    this.state = STOPPED;
                    break;
                }
            }
            else {
                no_command_count = 0;
                await new Promise(r => setTimeout(r, this.cooldown));
            }
        }
        console.log('self prompt loop stopped')
        this.loop_active = false;
        this.interrupt = false;
    }

    update(delta) {
        // automatically restarts loop
        if (this.state === ACTIVE && !this.loop_active && !this.interrupt) {
            if (this.agent.isIdle())
                this.idle_time += delta;
            else
                this.idle_time = 0;

            if (this.idle_time >= this.cooldown) {
                console.log('Restarting self-prompting...');
                this.startLoop();
                this.idle_time = 0;
            }
        }
        else if (this.state === ACTIVE && this._goalPaused && !this.interrupt
                 && this.agent.temporalWorkflowHandle) {
            // Temporal GoalPursuit is paused — resume once the bot is idle again
            if (this.agent.isIdle())
                this.idle_time += delta;
            else
                this.idle_time = 0;

            if (this.idle_time >= this.cooldown) {
                console.log('Resuming self-prompting...');
                this.startLoop(); // sends resumeGoalPursuit
                this.idle_time = 0;
            }
        }
        else {
            this.idle_time = 0;
        }
    }

    async stopLoop() {
        // you can call this without await if you don't need to wait for it to finish
        if (this.interrupt)
            return;
        console.log('stopping self-prompt loop')
        this.interrupt = true;
        if (this.agent.temporalWorkflowHandle) {
            // Pause the GoalPursuit rather than killing it — prevents a new child
            // from being spawned on every mode interrupt (item_collecting, hunting, etc.)
            const needsSignal = this.loop_active && !this._goalPaused;
            if (needsSignal) {
                this._goalPaused = true;
            }
            // Clear interrupt BEFORE the async signal send so that the running
            // executeLLMGoalIteration activity's handleMessage call is never
            // interrupted by the interrupt flag during this await window.
            this.interrupt = false;
            if (needsSignal) {
                await this.agent.temporalWorkflowHandle
                    .signal('pauseGoalPursuit')
                    .catch(err => console.warn('[Temporal] pauseGoalPursuit signal failed:', err));
            }
            return;
        }
        while (this.loop_active) {
            await new Promise(r => setTimeout(r, 500));
        }
        this.interrupt = false;
    }

    async stop(stop_action=true) {
        this.interrupt = true;
        if (stop_action)
            await this.agent.actions.stop();
        // With Temporal, stopLoop() only pauses — we need a hard stop here
        if (this.agent.temporalWorkflowHandle && this.loop_active) {
            await this.agent.temporalWorkflowHandle
                .signal('stopGoalPursuit')
                .catch(err => console.warn('[Temporal] stopGoalPursuit signal failed:', err));
            this.loop_active = false;
            this._goalPaused = false;
            this.interrupt = false;
        } else {
            this.stopLoop();
        }
        this.state = STOPPED;
    }

    async pause() {
        this.interrupt = true;
        await this.agent.actions.stop();
        this.stopLoop();
        this.state = PAUSED;
    }

    shouldInterrupt(is_self_prompt) { // to be called from handleMessage
        return is_self_prompt && (this.state === ACTIVE || this.state === PAUSED) && this.interrupt;
    }

    // Called by the GoalPursuit Temporal activity when the workflow exits
    // naturally (3 consecutive no-command responses).
    onGoalPursuitEnded() {
        this.loop_active = false;
        this._goalPaused = false;
        this.interrupt = false;
        this.state = STOPPED;
        console.log('Goal pursuit ended — auto-prompting stopped.');
        this.agent.openChat('Agent did not use command in the last 3 auto-prompts. Stopping auto-prompting.');
    }

    handleUserPromptedCmd(is_self_prompt, is_action) {
        // if a user messages and the bot responds with an action, stop the self-prompt loop
        if (!is_self_prompt && is_action) {
            this.stopLoop();
            // this stops it from responding from the handlemessage loop and the self-prompt loop at the same time
        }
    }
}