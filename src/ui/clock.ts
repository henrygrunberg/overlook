import { h } from "./dom";

export interface ClockText {
  readonly time: string;
  readonly date: string;
  readonly greeting: string;
}

export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

const TIME_FORMAT: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};
const DATE_FORMAT: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "long" };

export function clockText(date: Date, locale?: string): ClockText {
  return {
    time: date.toLocaleTimeString(locale, TIME_FORMAT),
    date: date.toLocaleDateString(locale, DATE_FORMAT),
    greeting: greetingFor(date.getHours()),
  };
}

export function mountClock(root: HTMLElement): void {
  // The greeting is English, but the date and time follow the browser's language.
  const locale = new Intl.DateTimeFormat().resolvedOptions().locale;
  const time = h("time", { className: "clock__time", attributes: { lang: locale } });
  const date = h("p", { className: "clock__date", attributes: { lang: locale } });
  const greeting = h("h1", { className: "clock__greeting" });
  root.replaceChildren(time, h("div", { className: "clock__details" }, [date, greeting]));

  const update = () => {
    const now = new Date();
    const text = clockText(now, locale);
    time.textContent = text.time;
    time.dateTime = now.toISOString();
    date.textContent = text.date;
    greeting.textContent = text.greeting;
  };

  const scheduleNextMinute = () => {
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    window.setTimeout(() => {
      if (!document.hidden) update();
      scheduleNextMinute();
    }, msToNextMinute + 50);
  };

  update();
  scheduleNextMinute();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) update();
  });
}
