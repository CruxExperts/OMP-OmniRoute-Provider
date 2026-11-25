import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as tui from "@oh-my-pi/pi-tui";

type Ui = ExtensionContext["ui"];
type CustomView = Awaited<ReturnType<Parameters<Ui["custom"]>[0]>>;
type InputOptions = NonNullable<Parameters<Ui["input"]>[2]> & { secret: boolean };

interface LegacyInput {
  prompt: string;
  mask: boolean;
  setValue(value: string): void;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  render(width: number): readonly string[];
  describe(context: unknown): unknown;
}

// OMP 19 removed the component API and added secret masking to host dialogs.
// Resolve the old component from the host namespace only on OMP 18.
const legacyTui = tui as unknown as {
  Input?: new () => LegacyInput;
  col(children: unknown[], options: { gap: "sm" }): unknown;
  text(line: string): unknown;
  wrapTextWithAnsi(line: string, width: number): readonly string[];
};

export async function promptText(context: ExtensionContext, prompt: string, secret = false, initial = "", helpLines: readonly string[] = []): Promise<string | undefined> {
  if (context.mode !== "tui") return undefined;
  const { ui } = context;
  const Input = legacyTui.Input;
  if (!Input) {
    const title = [prompt, ...helpLines].join("\n");
    const options: InputOptions = { secret };
    const value = initial && !secret
      ? await ui.editor(title, initial, undefined, { promptStyle: true })
      : await ui.input(title, undefined, options);
    return value || undefined;
  }

  class GuidedInput extends Input {
    override render(width: number): readonly string[] {
      return helpLines.length ? [...helpLines.flatMap(line => legacyTui.wrapTextWithAnsi(line, width)), ...super.render(width)] : super.render(width);
    }

    override describe(context: unknown): unknown {
      const node = super.describe(context);
      return helpLines.length ? legacyTui.col([...helpLines.map(line => legacyTui.text(line)), node], { gap: "sm" }) : node;
    }
  }

  return ui.custom<string | undefined>((_tui, _theme, _keys, done) => {
    const input = new GuidedInput();
    input.prompt = `${prompt}: `;
    input.mask = secret;
    if (initial && !secret) input.setValue(initial);
    const finish = (value: string | undefined) => { input.setValue(""); done(value || undefined); };
    input.onSubmit = finish;
    input.onEscape = () => finish(undefined);
    // This branch returns the real OMP 18 component, not the OMP 19 view type.
    return input as unknown as CustomView;
  }, { overlay: true });
}
