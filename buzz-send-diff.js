import { runBuzz, mergeParams, requireFields, successResult, errorResult } from './buzz-common.js';

/**
 * buzz-send-diff
 * Wrap: buzz messages send-diff --channel <uuid> --diff - [--repo] [--commit]
 * Unified diff body via stdin.
 */
class BuzzSendDiff {
  constructor() {
    this.name = 'buzz-send-diff';
  }

  async execute(params, inputData, workflowEngine) {
    try {
      const p = mergeParams(params, inputData, workflowEngine);
      const channel = p.channel || p.channelId;
      const diff = p.diff || p.patch || p.content;
      const missing = requireFields({ channel, diff }, ['channel', 'diff']);
      if (missing) return errorResult(missing);

      const args = ['messages', 'send-diff', '--channel', String(channel), '--diff', '-'];
      if (p.repo) args.push('--repo', String(p.repo));
      if (p.commit) args.push('--commit', String(p.commit));
      if (p.replyTo || p.reply_to) {
        args.push('--reply-to', String(p.replyTo || p.reply_to));
      }

      const run = await runBuzz(args, {
        params: p,
        stdin: String(diff),
      });

      if (!run.success) {
        return errorResult(run.error, { exitCode: run.exitCode, stderr: run.stderr });
      }

      return successResult(run.data, {
        channel,
        repo: p.repo || null,
        commit: p.commit || null,
        exitCode: run.exitCode,
      });
    } catch (error) {
      console.error('[buzz-send-diff]', error);
      return errorResult(error);
    }
  }
}

export default new BuzzSendDiff();
