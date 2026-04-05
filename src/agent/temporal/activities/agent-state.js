// Lifecycle event stamping — no-op stub that writes to bot.output so that
// login/spawn/disconnect/task-done events appear on the Temporal timeline.
export function createAgentStateActivities(agent) {
    return {
        async notifyAgentEvent(event, data) {
            const msg = `[Temporal] ${event}${data ? ': ' + JSON.stringify(data) : ''}`;
            if (agent.bot) {
                agent.bot.output = (agent.bot.output || '') + '\n' + msg;
            }
            console.log(msg);
        },
    };
}
