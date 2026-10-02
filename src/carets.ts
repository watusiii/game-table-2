// The shape of another person's caret, as the editor draws it.
export interface DrawnCaret {
  id: string;
  name: string;
  color: string;
  start: number;
  end: number;
  back: boolean;
}
