import { heartbeat } from '@temporalio/activity';
import * as skills from '../../library/skills.js';

// Deterministic wrappers around skills.js functions.
// Each activity heartbeats periodically and returns { success, message }.
export function createMineflayerSkillActivities(agent) {
    const bot = () => agent.bot;

    async function runSkill(label, fn) {
        const interval = setInterval(() => heartbeat(label), 10_000);
        try {
            await fn();
            return { success: true, message: `${label} completed.` };
        } catch (err) {
            return { success: false, message: `${label} failed: ${err.message}` };
        } finally {
            clearInterval(interval);
        }
    }

    return {
        async collectBlocks({ blockType, num }) {
            return runSkill(`collectBlocks(${blockType}, ${num})`, () =>
                skills.collectBlock(bot(), blockType, num),
            );
        },

        async goToPosition({ x, y, z, minDist = 2 }) {
            return runSkill(`goToPosition(${x}, ${y}, ${z})`, () =>
                skills.goToPosition(bot(), x, y, z, minDist),
            );
        },

        async craftItem({ itemName, num = 1 }) {
            return runSkill(`craftItem(${itemName}, ${num})`, () =>
                skills.craftRecipe(bot(), itemName, num),
            );
        },

        async smeltItem({ itemName, num = 1 }) {
            return runSkill(`smeltItem(${itemName}, ${num})`, () =>
                skills.smeltItem(bot(), itemName, num),
            );
        },

        async attackNearest({ mobType }) {
            return runSkill(`attackNearest(${mobType})`, () =>
                skills.attackNearest(bot(), mobType),
            );
        },
    };
}
