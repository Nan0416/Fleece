/**
 * Tells a person what a position monitor run found, and how that looks in Discord.
 *
 * Two channels. The monitor channel, meant to be muted, gets a card per spread on every run.
 * The attention channel, meant to notify, gets a card per signal or failure, on every run
 * the condition holds, and nothing when there is neither. Spreads are cards rather than a
 * table because Discord fits a card to the screen, while a code block wider than a phone is
 * wrapped there rather than scrolled.
 */
import { easternClock } from '@fleece/utilities';
import { escapeMarkdown, WebhookClient, type APIEmbed, type APIEmbedField } from 'discord.js';

import { dollars, errorMessage, optionLetter, percentOf, shortDate, signedDollars, strike } from './formatting';
import type { PositionMonitorOutcome, PositionMonitorReport } from './position-monitor';
import type { CreditSpreadMetrics, Signal, SignalKind, Strategy, StrategyEvaluation } from './strategies';

export interface Notifier {
  /** Delivers `outcome` to everywhere it goes, and throws if any of them refused it. */
  notify(outcome: PositionMonitorOutcome): Promise<void>;
  /** Releases what the notifier holds open, so the process can exit. */
  close(): void;
}

export interface DiscordNotifierProps {
  /** Webhook of the channel every run posts to. */
  readonly monitorWebhookUrl: string;
  /** Webhook of the channel only signals and failures are posted to. */
  readonly attentionWebhookUrl: string;
}

/** One Discord post. */
export interface DiscordMessage {
  readonly content?: string;
  readonly embeds?: ReadonlyArray<APIEmbed>;
}

/** Discord refuses a message past any of these. */
const LIMITS = {
  content: 2_000,
  embedsPerMessage: 10,
  embedTitle: 256,
  embedDescription: 4_096,
  fieldValue: 1_024,
  fieldsPerEmbed: 25,
  /** Across every embed in one message. */
  embedCharacters: 6_000,
} as const;

const TITLE = 'Credit spreads';
/** A value that could not be had, such as a mark with no quote. */
const NONE = '—';
const WARNING = '⚠️';
const QUIET_COLOR = 0x95a5a6;
const FAILURE_COLOR = 0x992d22;

interface SignalStyle {
  readonly label: string;
  readonly emoji: string;
  readonly color: number;
  /** Lower is more urgent, and a card with several signals takes the most urgent one's color. */
  readonly urgency: number;
}

const SIGNAL_STYLES: Record<SignalKind, SignalStyle> = {
  'stop-loss': { label: 'Stop loss', emoji: '🔴', color: 0xe74c3c, urgency: 0 },
  'days-to-expiration': { label: 'Expiring', emoji: '🟠', color: 0xe67e22, urgency: 1 },
  'take-profit': { label: 'Take profit', emoji: '🟢', color: 0x2ecc71, urgency: 2 },
};

interface Channel {
  readonly name: string;
  readonly client: WebhookClient;
  readonly render: (outcome: PositionMonitorOutcome) => DiscordMessage[];
}

/**
 * Posts each run to the two channels through their webhooks.
 *
 * A URL carries its webhook's token. Nothing here logs one, and a failed post is reported
 * as an error naming the channel, because Discord's own error keeps the URL it was sent to.
 */
export class DiscordNotifier implements Notifier {
  private readonly channels: ReadonlyArray<Channel>;

  constructor(props: DiscordNotifierProps) {
    this.channels = [
      { name: 'monitor', client: new WebhookClient({ url: props.monitorWebhookUrl }), render: renderMonitorChannel },
      { name: 'attention', client: new WebhookClient({ url: props.attentionWebhookUrl }), render: renderAttentionChannel },
    ];
  }

  async notify(outcome: PositionMonitorOutcome): Promise<void> {
    const deliveries = this.channels.map((channel) => ({ channel, posts: channel.render(outcome) }));
    // Checked before anything is sent, so a channel never gets the first half of a run.
    for (const { channel, posts } of deliveries) {
      posts.forEach((post) => requireWithinLimits(post, channel.name));
    }

    // Every channel is tried, so one refusing a post does not keep the other from its own.
    const refusals: string[] = [];
    for (const { channel, posts } of deliveries) {
      try {
        for (const { content, embeds } of posts) {
          // Text built from positions and errors pings nobody; the channel's own
          // notification setting is what decides who hears about it.
          await channel.client.send({ content, embeds: embeds === undefined ? undefined : [...embeds], allowedMentions: { parse: [] } });
        }
      } catch (error) {
        refusals.push(`the ${channel.name} channel: ${errorMessage(error)}`);
      }
    }
    if (refusals.length > 0) {
      throw new Error(`Could not post to ${refusals.join('; ')}`);
    }
  }

  close(): void {
    this.channels.forEach((channel) => channel.client.destroy());
  }
}

/** Every run: a header naming what was found, then a card per spread and per spread that could not be checked. */
export function renderMonitorChannel(outcome: PositionMonitorOutcome): DiscordMessage[] {
  if (outcome.kind === 'failed') {
    return [{ content: truncate(`**${TITLE}** · ${when(outcome.at)} · **run failed**\n${WARNING} ${escapeMarkdown(errorMessage(outcome.error))}`, LIMITS.content) }];
  }
  const { report } = outcome;
  const today = easternClock.date(report.at);
  const embeds = [
    ...report.evaluations.map((evaluation) => spreadCard(evaluation, today)),
    ...report.failures.map((failure) => failureCard(`Could not check ${strategyTitle(failure.strategy, today)}`, failure.error)),
  ];

  const content = truncate([header(report), ...unmatched(report)].join('\n'), LIMITS.content);
  const chunks = packCards(embeds.map((embed) => ({ embed })));
  if (chunks.length === 0) {
    return [{ content }];
  }
  return chunks.map((chunk, index) => ({ content: index === 0 ? content : undefined, embeds: chunk.map((card) => card.embed) }));
}

/** Only signals and failures, a card each, with a plain line naming them all for the push notification. */
export function renderAttentionChannel(outcome: PositionMonitorOutcome): DiscordMessage[] {
  if (outcome.kind === 'failed') {
    const title = 'Position monitor run failed';
    return [{ content: `${WARNING} ${title}`, embeds: [{ ...failureCard(title, outcome.error), timestamp: new Date(outcome.at).toISOString() }] }];
  }
  const { report } = outcome;
  const today = easternClock.date(report.at);
  const timestamp = new Date(report.at).toISOString();
  const cards: Array<{ readonly headline: string; readonly embed: APIEmbed }> = [];
  for (const evaluation of report.evaluations) {
    for (const signal of evaluation.signals) {
      const style = SIGNAL_STYLES[signal.kind];
      cards.push({ headline: `${style.emoji} ${style.label} ${spreadLabel(evaluation.strategy, today)}`, embed: { ...signalCard(evaluation, signal, today), timestamp } });
    }
  }
  for (const failure of report.failures) {
    cards.push({
      headline: `${WARNING} Could not check ${spreadLabel(failure.strategy, today)}`,
      embed: { ...failureCard(`Could not check ${strategyTitle(failure.strategy, today)}`, failure.error), timestamp },
    });
  }

  return packCards(cards).map((chunk) => ({
    content: truncate(chunk.map((card) => card.headline).join(' · '), LIMITS.content),
    embeds: chunk.map((card) => card.embed),
  }));
}

function header(report: PositionMonitorReport): string {
  const signals = report.evaluations.reduce((count, evaluation) => count + evaluation.signals.length, 0);
  const parts = [`**${TITLE}**`, when(report.at), count(report.evaluations.length, 'spread'), count(signals, 'signal')];
  if (report.failures.length > 0) {
    parts.push(`**${report.failures.length} failed**`);
  }
  return parts.join(' · ');
}

function unmatched(report: PositionMonitorReport): string[] {
  if (report.unmatched.length === 0) {
    return [];
  }
  return [`Unmatched: ${report.unmatched.map((leg) => `${leg.contract.symbol} x${leg.quantity.toString()}`).join(', ')}`];
}

/** A spread's state, colored by its most urgent signal, with its signals and warnings as the description. */
function spreadCard({ strategy, metrics, signals, warnings }: StrategyEvaluation, today: string): APIEmbed {
  const lines = [
    ...signals.map((signal) => `${SIGNAL_STYLES[signal.kind].emoji} **${SIGNAL_STYLES[signal.kind].label}**: ${signal.reason}`),
    ...warnings.map((warning) => `${WARNING} ${escapeMarkdown(warning)}`),
  ];
  const urgent = [...signals].sort((a, b) => SIGNAL_STYLES[a.kind].urgency - SIGNAL_STYLES[b.kind].urgency)[0];
  return {
    title: truncate(strategyTitle(strategy, today), LIMITS.embedTitle),
    description: lines.length === 0 ? undefined : truncate(lines.join('\n'), LIMITS.embedDescription),
    color: urgent === undefined ? QUIET_COLOR : SIGNAL_STYLES[urgent.kind].color,
    fields: metricFields(metrics),
  };
}

function signalCard({ strategy, metrics }: StrategyEvaluation, signal: Signal, today: string): APIEmbed {
  const style = SIGNAL_STYLES[signal.kind];
  return {
    title: truncate(`${style.emoji} ${style.label} · ${strategyTitle(strategy, today)}`, LIMITS.embedTitle),
    description: signal.reason,
    color: style.color,
    fields: metricFields(metrics),
  };
}

function failureCard(title: string, error: unknown): APIEmbed {
  return {
    title: truncate(`${WARNING} ${title}`, LIMITS.embedTitle),
    description: truncate(escapeMarkdown(errorMessage(error)), LIMITS.embedDescription),
    color: FAILURE_COLOR,
  };
}

/** Six inline fields, which Discord shows as two rows of three where there is room. */
function metricFields(metrics: CreditSpreadMetrics): APIEmbedField[] {
  const { credit, unrealizedProfit, closeAtNatural, netDelta, shortDelta, daysToExpiration } = metrics;
  let profit = NONE;
  if (unrealizedProfit !== undefined) {
    profit = credit.isPositive() ? `${signedDollars(unrealizedProfit)} (${percentOf(unrealizedProfit, credit, 0)})` : signedDollars(unrealizedProfit);
  }
  return [
    { name: 'P&L', value: profit, inline: true },
    { name: 'Credit', value: dollars(credit), inline: true },
    { name: 'Close (natural)', value: closeAtNatural === undefined ? NONE : dollars(closeAtNatural), inline: true },
    { name: 'Net Δ', value: fixed(netDelta, 1), inline: true },
    { name: 'Short Δ', value: fixed(shortDelta, 2), inline: true },
    { name: 'DTE', value: String(daysToExpiration), inline: true },
  ];
}

/**
 * `cards` in order, grouped into as few posts as Discord takes: at most ten embeds, and at
 * most 6,000 characters across them, in each.
 */
export function packCards<T extends { readonly embed: APIEmbed }>(cards: ReadonlyArray<T>): T[][] {
  const posts: T[][] = [];
  let current: T[] = [];
  let characters = 0;
  for (const card of cards) {
    const size = embedCharacters(card.embed);
    if (current.length === LIMITS.embedsPerMessage || (current.length > 0 && characters + size > LIMITS.embedCharacters)) {
      posts.push(current);
      current = [];
      characters = 0;
    }
    current.push(card);
    characters += size;
  }
  if (current.length > 0) {
    posts.push(current);
  }
  return posts;
}

/** A rendering mistake, named here rather than as Discord's 400 about a field path. */
function requireWithinLimits(post: DiscordMessage, channel: string): void {
  const content = post.content ?? '';
  const embeds = post.embeds ?? [];
  const problems: string[] = [];
  if (content.length === 0 && embeds.length === 0) {
    problems.push('it is empty');
  }
  if (content.length > LIMITS.content) {
    problems.push(`its content is ${content.length} characters`);
  }
  if (embeds.length > LIMITS.embedsPerMessage) {
    problems.push(`it has ${embeds.length} embeds`);
  }
  for (const embed of embeds) {
    const fields = embed.fields ?? [];
    if ((embed.title ?? '').length > LIMITS.embedTitle || (embed.description ?? '').length > LIMITS.embedDescription) {
      problems.push(`the embed "${embed.title ?? ''}" has a title or description over the limit`);
    }
    if (fields.length > LIMITS.fieldsPerEmbed || fields.some((field) => field.value.length > LIMITS.fieldValue)) {
      problems.push(`the embed "${embed.title ?? ''}" has too many fields or one too long`);
    }
  }
  const characters = embeds.reduce((sum, embed) => sum + embedCharacters(embed), 0);
  if (characters > LIMITS.embedCharacters) {
    problems.push(`its embeds hold ${characters} characters`);
  }
  if (problems.length > 0) {
    throw new Error(`A post rendered for the ${channel} channel breaks Discord's limits: ${problems.join('; ')}.`);
  }
}

/** What Discord counts toward a message's embed total. */
function embedCharacters(embed: APIEmbed): number {
  const fields = embed.fields ?? [];
  return (
    (embed.title ?? '').length +
    (embed.description ?? '').length +
    (embed.footer?.text ?? '').length +
    (embed.author?.name ?? '').length +
    fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  );
}

/** `AAPL 10/23 360/375C`, for the one-line push notification. */
function spreadLabel(strategy: Strategy, today: string): string {
  return `${strategy.underlying} ${shortDate(strategy.expiration, today)} ${strategy.strikes.map(strike).join('/')}${optionLetter(strategy.optionType)}`;
}

/** `AAPL 10/23 360/375 bear call spread ×1`, for a card's title. */
function strategyTitle(strategy: Strategy, today: string): string {
  return `${strategy.underlying} ${shortDate(strategy.expiration, today)} ${strategy.strikes.map(strike).join('/')} ${strategy.name} ×${strategy.quantity.toString()}`;
}

function when(at: number): string {
  const today = easternClock.date(at);
  return `${shortDate(today, today)} ${easternClock.time(at).slice(0, 5)} ET`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Fixed places, without the `-0.0` that a delta a hair below zero would print as. */
function fixed(value: number | undefined, digits: number): string {
  if (value === undefined) {
    return NONE;
  }
  const text = value.toFixed(digits);
  return Number(text) === 0 ? (0).toFixed(digits) : text;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
