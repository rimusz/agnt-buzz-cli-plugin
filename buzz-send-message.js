import { runBuzz, mergeParams, requireFields, successResult, errorResult } from './buzz-common.js';

/**
 * buzz-send-message
 * Wrap: buzz messages send --channel <uuid> --content ... [--reply-to] [--broadcast]
 */
class BuzzSendMessage {
  constructor() {
    this.name = 'buzz-send-message';
  }

  async execute(params, inputData, workflowEngine) {
    try {
      const p = mergeParams(params, inputData, workflowEngine);
      const channel = p.channel || p.channelId;
      const content = p.content || p.message;
      const missing = requireFields({ channel, content }, ['channel', 'content']);
      if (missing) return errorResult(missing);

      const args = ['messages', 'send', '--channel', String(channel)];

      // Prefer stdin for long / multiline bodies
      const useStdin = content.length > 500 || content.includes('\n') || p.useStdin === true || p.useStdin === 'true';
      if (useStdin) {
        args.push('--content', '-');
      } else {
        args.push('--content', String(content));
      }

      if (p.replyTo || p.reply_to) {
        args.push('--reply-to', String(p.replyTo || p.reply_to));
      }
      if (p.broadcast === true || p.broadcast === 'true') {
        args.push('--broadcast');
      }

      const run = await runBuzz(args, {
        params: p,
        stdin: useStdin ? String(content) : undefined,
      });

      if (!run.success) {
        return errorResult(run.error, { exitCode: run.exitCode, stderr: run.stderr });
      }

      return successResult(run.data, {
        channel,
        replyTo: p.replyTo || p.reply_to || null,
        exitCode: run.exitCode,
      });
    } catch (error) {
      console.error('[buzz-send-message]', error);
      return errorResult(error);
    }
  }
}

export default new BuzzSendMessage();
