/**
 * Runs before any module is imported, which is what this needs: `LoggerFactory`
 * resolves its level in a static initialiser, so setting the variable from inside a
 * test would be too late.
 *
 * Tests assert on behaviour, never on log output, and the ones that deliberately
 * exercise a failure path log exactly the warning they were written to provoke —
 * pure noise that buries the one line that matters when something really breaks.
 * Set the variable yourself to get it back: `FLEECE_LOG_LEVEL=debug npm test`.
 */
process.env.FLEECE_LOG_LEVEL = process.env.FLEECE_LOG_LEVEL ?? 'error';
