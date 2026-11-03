import { fromSwissInput, swissParts } from './time.ts';

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
export interface CalendarDate { year: number; month: number; day: number; }

export function monthDays(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
export function monthCells(year: number, month: number): (number | null)[] {
  const offset = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const result: (number | null)[] = Array(offset).fill(null);
  for (let day = 1; day <= monthDays(year, month); day++) result.push(day);
  while (result.length % 7) result.push(null);
  return result;
}
export function shiftMonth(date: CalendarDate, amount: number): CalendarDate {
  const value = new Date(Date.UTC(date.year, date.month - 1 + amount, 1));
  const year = Math.max(1900, Math.min(2100, value.getUTCFullYear()));
  const month = value.getUTCFullYear() === year ? value.getUTCMonth() + 1 : value.getUTCFullYear() < 1900 ? 1 : 12;
  return { year, month, day: Math.min(date.day, monthDays(year, month)) };
}
export function calendarInstant(date: CalendarDate, hour: string, minute: string, second: string): number {
  if (![hour, minute, second].every(value => /^\d{1,2}$/.test(value))) throw new RangeError('Enter a complete 24-hour time.');
  return fromSwissInput(`${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}T`
    + `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`);
}

export class CalendarPopup {
  private readonly dialog: HTMLDialogElement;
  private readonly trigger: HTMLButtonElement;
  private readonly applied: (epoch: number) => void;
  private selected: CalendarDate = { year: 2000, month: 1, day: 1 };
  private visible = { year: 2000, month: 1, day: 1 };
  private readonly grid: HTMLElement;
  private readonly year: HTMLInputElement;
  private readonly month: HTMLSelectElement;
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly fields: HTMLInputElement[];
  private readonly error: HTMLElement;

  constructor(dialog: HTMLDialogElement, trigger: HTMLButtonElement, applied: (epoch: number) => void) {
    this.dialog = dialog; this.trigger = trigger; this.applied = applied;
    this.grid = dialog.querySelector<HTMLElement>('#calendar-grid')!;
    this.year = dialog.querySelector<HTMLInputElement>('#calendar-year')!;
    this.month = dialog.querySelector<HTMLSelectElement>('#calendar-month')!;
    this.previous = dialog.querySelector<HTMLButtonElement>('#previous-month')!;
    this.next = dialog.querySelector<HTMLButtonElement>('#next-month')!;
    this.fields = ['hour-input', 'minute-input', 'second-input'].map(id => dialog.querySelector<HTMLInputElement>(`#${id}`)!);
    this.error = dialog.querySelector<HTMLElement>('#date-error')!;
    for (const [index, label] of MONTHS.entries()) {
      const option = document.createElement('option'); option.value = String(index + 1); option.textContent = label;
      this.month.append(option);
    }
    const clearError = () => {
      this.error.textContent = ''; this.year.removeAttribute('aria-invalid');
      for (const field of this.fields) field.removeAttribute('aria-invalid');
    };
    const navigate = (date: CalendarDate) => {
      clearError(); this.visible = { ...date }; this.selected = { ...date }; this.render();
    };
    this.previous.addEventListener('click', () => navigate(shiftMonth(this.visible, -1)));
    this.next.addEventListener('click', () => navigate(shiftMonth(this.visible, 1)));
    this.month.addEventListener('change', () => navigate({ ...this.visible, month: +this.month.value,
      day: Math.min(this.selected.day, monthDays(this.visible.year, +this.month.value)) }));
    this.year.addEventListener('input', () => {
      const year = +this.year.value;
      if (!Number.isInteger(year) || year < 1900 || year > 2100) {
        this.error.textContent = 'Choose a year between 1900 and 2100.';
        this.year.setAttribute('aria-invalid', 'true'); return;
      }
      this.year.removeAttribute('aria-invalid'); this.error.textContent = '';
      navigate({ ...this.visible, year, day: Math.min(this.selected.day, monthDays(year, this.visible.month)) });
    });
    this.grid.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-day]');
      if (!button) return;
      clearError();
      this.selected = { ...this.visible, day: +button.dataset.day! };
      this.visible = { ...this.selected };
      this.render(true);
    });
    this.grid.addEventListener('keydown', event => this.keydown(event));
    for (const field of this.fields) field.addEventListener('blur', () => {
      if (/^\d{1,2}$/.test(field.value)) field.value = field.value.padStart(2, '0');
    });
    dialog.querySelector('#cancel')!.addEventListener('click', () => this.close());
    dialog.querySelector('#close-dialog')!.addEventListener('click', () => this.close());
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.close();
    });
    dialog.addEventListener('close', () => this.trigger.focus({ preventScroll: true }));
    dialog.querySelector('form')!.addEventListener('submit', event => {
      event.preventDefault();
      try {
        const year = +this.year.value;
        if (!Number.isInteger(year) || year < 1900 || year > 2100) {
          this.error.textContent = 'Choose a year between 1900 and 2100.';
          this.year.setAttribute('aria-invalid', 'true'); this.year.focus(); return;
        }
        this.year.removeAttribute('aria-invalid');
        const chosen = { year, month: +this.month.value, day: Math.min(this.selected.day, monthDays(year, +this.month.value)) };
        const epoch = calendarInstant(chosen, this.fields[0].value, this.fields[1].value, this.fields[2].value);
        this.applied(epoch); this.close();
      } catch (error) {
        this.error.textContent = error instanceof RangeError ? error.message : 'Enter a valid date and time.';
        this.fields[0].setAttribute('aria-invalid', 'true'); this.fields[0].focus();
      }
    });
  }

  open(epoch: number): void {
    const p = swissParts(epoch);
    this.selected = { year: p.year, month: p.month, day: p.day };
    this.visible = { ...this.selected };
    for (const [index, value] of [p.hour, p.minute, p.second].entries()) {
      this.fields[index].value = String(value).padStart(2, '0');
      this.fields[index].removeAttribute('aria-invalid');
    }
    this.year.removeAttribute('aria-invalid');
    this.error.textContent = '';
    this.render();
    this.dialog.showModal();
    this.grid.querySelector<HTMLButtonElement>('[tabindex="0"]')!.focus();
  }

  private close(): void { this.dialog.close(); }

  private render(focus = false): void {
    const { year, month } = this.visible;
    this.year.value = String(year); this.month.value = String(month);
    this.previous.disabled = year === 1900 && month === 1;
    this.next.disabled = year === 2100 && month === 12;
    this.grid.setAttribute('aria-label', `${MONTHS[month - 1]} ${year}`);
    const today = swissParts(Date.now());
    const currentMonth = this.selected.year === year && this.selected.month === month;
    const focusDay = currentMonth ? this.selected.day : 1;
    const fragment = document.createDocumentFragment();
    const cells = monthCells(year, month);
    for (let index = 0; index < cells.length; index += 7) {
      const row = document.createElement('div'); row.setAttribute('role', 'row');
      for (const day of cells.slice(index, index + 7)) {
        const cell = document.createElement('div'); cell.setAttribute('role', 'gridcell');
        if (day !== null) {
          const selected = currentMonth && day === this.selected.day;
          cell.setAttribute('aria-selected', String(selected));
          const button = document.createElement('button'); button.type = 'button'; button.dataset.day = String(day);
          button.textContent = String(day); button.tabIndex = day === focusDay ? 0 : -1;
          button.setAttribute('aria-label', `${day} ${MONTHS[month - 1]} ${year}`);
          if (selected) button.classList.add('selected');
          if (today.year === year && today.month === month && today.day === day) button.setAttribute('aria-current', 'date');
          cell.append(button);
        }
        row.append(cell);
      }
      fragment.append(row);
    }
    this.grid.replaceChildren(fragment);
    if (focus) this.grid.querySelector<HTMLButtonElement>('[tabindex="0"]')!.focus();
  }

  private keydown(event: KeyboardEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-day]');
    if (!button) return;
    const date = { ...this.visible, day: +button.dataset.day! };
    const stamp = Date.UTC(date.year, date.month - 1, date.day);
    let next: CalendarDate;
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in moves) {
      const shifted = new Date(stamp + moves[event.key] * 86_400_000);
      next = { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      next = shiftMonth(date, (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1));
    } else if (event.key === 'Home' || event.key === 'End') {
      const weekday = (new Date(stamp).getUTCDay() + 6) % 7;
      const shifted = new Date(stamp + (event.key === 'Home' ? -weekday : 6 - weekday) * 86_400_000);
      next = { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
    } else return;
    event.preventDefault();
    if (next.year < 1900 || next.year > 2100) return;
    this.visible = { ...next }; this.selected = { ...next }; this.render(true);
  }
}
