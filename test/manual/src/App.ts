import "../../../css/flicking-inline.css";
import Flicking, { ALIGN, EVENTS } from "~/index";
import { ValueOf } from "~/type/internal";

class App {
  public constructor() {
    const flicking = new Flicking("#flicking", {
      align: ALIGN.CENTER,
      bound: true,
      moveType: ["freeScroll"],
      circular: true,
      renderOnlyVisible: true
    });

    // Object.values([EVENTS.WILL_CHANGE]).forEach((eventName: ValueOf<typeof EVENTS>) => {
    //   flicking.on(eventName, event => console.log(eventName, event));
    // });

    document.getElementById("prev")?.addEventListener("click", () => {
      flicking.prev().then(() => console.log("PREV FINISHED"));
    });

    document.getElementById("next")?.addEventListener("click", () => {
      flicking.next().then(() => console.log("NEXT FINISHED"));
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    (window as any).flicking = flicking;
  }
}

export default App;

// tslint:disable-next-line
new App();
