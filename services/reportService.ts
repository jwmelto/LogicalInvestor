import * as Linking from 'expo-linking';

const REPORT_TO = 'jwmelto@users.sourceforge.net';

// Every caller sources this from either an RssItem or a Topic's latest* preview fields — both
// guarantee all four of these (already stripped of HTML/entities), so nothing here is optional.
export interface ReportableItem {
  title: string;
  author: string;
  link: string;
  description: string;
}

export function reportMissedAlert(item: ReportableItem): void {
  const subject = `[LI Alert] Missed: ${item.title}`;
  const body = [
    `POST:   ${item.title}`,
    `AUTHOR: ${item.author}`,
    `LINK:   ${item.link}`,
    ``,
    `EXCERPT (${item.description.length} chars, threshold 200):`,
    item.description.slice(0, 500),
    ``,
    `---`,
    `This post did NOT trigger a notification but should have.`,
  ].join('\n');

  Linking.openURL(
    `mailto:${REPORT_TO}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  );
}
