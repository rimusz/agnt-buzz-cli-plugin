import { runBuzz, mergeParams, requireFields, successResult, errorResult } from './buzz-common.js';

/**
 * buzz-search
 * Wrap: buzz messages search --query "..." [--channel <uuid>] [--author <pubkey>]
 *                            [--since <iso|unix>] [--limit N]
 *
 * Full-text search across Buzz messages. Returns matching messages (array).
 */
class BuzzSearch {
  constructor() {
    this.name = 'buzz-search';
  }

  async execute(params, inputData, workflowEngine) {
    try {
      const p = mergeParams(params, inputData, workflowEngine);
      const query = p.query || p.q || p.search;
      const missing = requireFields({ query }, ['query']);
      if (missing) return errorResult(missing, { errorCategory: 'user_input' });

      const args = ['messages', 'search', '--query', String(query)];

      // Optional filters
      const channel = p.channel || p.channelId;
      if (channel) args.push('--channel', String(channel));

      const author = p.author || p.pubkey;
      if (author) args.push('--author', String(author));

      if (p.since != null && p.since !== '') args.push('--since', String(p.since));

      const limit = p.limit != null && p.limit !== '' ? Number(p.limit) : 20;
      args.push('--limit', String(limit));

      const run = await runBuzz(args, { params: p });
      if (!run.success) {
        // structured error (errorCategory/hint/retryable derived from exit code)
        return errorResult(run.error, { exitCode: run.exitCode, stderr: run.stderr });
      }

      const results = Array.isArray(run.data)
        ? run.data
        : run.data?.results || run.data?.messages || run.data?.items || run.data;

      return successResult(results, {
        query,
        channel,
        author,
        since: p.since,
        limit,
        count: Array.isArray(results) ? results.length : undefined,
        exitCode: run.exitCode,
      });
    } catch (error) {
      console.error('[buzz-search]', error);
      return errorResult(error);
    }
  }
}

export default new BuzzSearch();
