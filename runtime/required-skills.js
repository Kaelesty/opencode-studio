// Generated runtime definition owned by OpenCode Studio. No SDK dependency: Plugin.define is identity in V2.
import path from 'node:path';

export default {
  id: 'opencode-studio.required-skills',
  async setup(ctx) {
    const agents = ctx.options.agents || {};
    const registration = await ctx.session.hook('context', async event => {
      if (!Object.hasOwn(agents, event.agent)) return;
      const required = agents[event.agent].skills || [];
      if (!Array.isArray(required) || required.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid Studio required-skills configuration');
      if (!required.length) return;
      const { data: skills } = await ctx.skill.list();
      const blocks = [];
      for (const id of new Set(required)) {
        await ctx.permission.assert({ sessionID: event.sessionID, agent: event.agent, action: 'skill', resources: [id], save: [id] });
        const skill = skills.find(item => item.id === id);
        if (!skill) throw new Error(`Required skill is unavailable: ${id}`);
        blocks.push(`Skill: ${JSON.stringify(id)}\nBase directory: ${JSON.stringify(path.dirname(skill.path))}\n\n${skill.content}`);
      }
      event.system.push({
        type: 'text',
        text: 'Required skills loaded by OpenCode Studio. Apply their instructions to this task, subject to higher-priority instructions and policies. Their content is already loaded; a redundant skill tool call is unnecessary. Loading a skill does not grant permissions to its supporting tools.\n\n' + blocks.join('\n\n---\n\n'),
      });
    });
    return () => registration.dispose();
  },
};
