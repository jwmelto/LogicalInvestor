import * as Linking from 'expo-linking';
import { stripHtml } from '@li/core';

const REPORT_TO = 'jim@melton.space';

export interface ReportableItem {
  title?: string;
  author?: string;
  link?: string;
  excerpt?: string;
}

export function reportMissedAlert(item: ReportableItem): void {
  const title = item.title ?? '(no title)';
  const stripped = stripHtml(item.excerpt ?? '');
  const subject = `[LI Alert] Missed: ${title}`;
  const body = [
    `POST:   ${title}`,
    `AUTHOR: ${item.author ?? '(unknown)'}`,
    `LINK:   ${item.link ?? '(no link)'}`,
    ``,
    `EXCERPT (${stripped.length} chars, threshold 200):`,
    stripped.slice(0, 500),
    ``,
    `---`,
    `This post did NOT trigger a notification but should have.`,
  ].join('\n');

  Linking.openURL(
    `mailto:${REPORT_TO}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  );
}
