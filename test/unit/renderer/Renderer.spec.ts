import { ALIGN } from "~/const/external";
import Panel, { PanelOptions } from "~/core/panel/Panel";
import ElementPanel from "~/core/panel/ElementPanel";
import Renderer from "~/renderer/Renderer";
import { getFlickingAttached, toArray } from "~/utils";

import El from "../helper/El";
import { createFlicking, range } from "../helper/test-util";

class RendererImpl extends Renderer {
  public async render() { return; }
  public async forceRenderAllPanels() { return; }

  protected _collectPanels(): void {
    const flicking = getFlickingAttached(this._flicking, "Renderer");

    const cameraElement = flicking.camera.element;

    // Remove all text nodes in the camera element
    cameraElement.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        cameraElement.removeChild(node);
      }
    });

    const align = this._getPanelAlign();
    const cameraChilds = toArray(cameraElement.children);

    this._panels = cameraChilds.map(
      (el: HTMLElement, index: number) => new ElementPanel({ flicking, el, index, align })
    );
  }

  protected _createPanel(el: any, options: PanelOptions): Panel { return new ElementPanel({ el, ...options }); }
  protected _insertPanelElements(panels: Panel[], nextSibling: Panel | null): void {}
  protected _removePanelElements(panels: Panel[]): void {}
}

describe("Renderer", () => {
  describe("Properties", () => {
    it("has empty array as a default panels", () => {
      expect(new RendererImpl().panels).to.deep.equal([]);
    });

    it("has 0 as a default panelCount", () => {
      expect(new RendererImpl().panelCount).to.equal(0);
    });
  });

  describe("Options", () => {
    it(`has ${ALIGN.CENTER} as a default align value`, () => {
      expect(new RendererImpl().align).to.equal(ALIGN.CENTER);
    });

    it("should have the same align value in constructor", () => {
      expect(new RendererImpl({ align: ALIGN.NEXT }).align).equals(ALIGN.NEXT);
    });

    it("can be changed anytime", () => {
      const renderer = new RendererImpl({ align: ALIGN.PREV });

      renderer.align = "300px";

      expect(renderer.align).to.equal("300px");
    });
  });

  describe("Methods", () => {
    describe("getPanel", () => {
      it("should return panel which has same index to given index", async () => {
        const flicking = await createFlicking(El.DEFAULT_HORIZONTAL);
        const renderer = new RendererImpl().init(flicking);

        expect(renderer.getPanel(0).index).to.equal(0);
        expect(renderer.getPanel(1).index).to.equal(1);
        expect(renderer.getPanel(2).index).to.equal(2);
      });
    });

    describe("updatePanelSize", () => {
      it("should update panel sizes", async () => {
        const flicking = await createFlicking(El.DEFAULT_HORIZONTAL);
        const renderer = new RendererImpl().init(flicking);
        const prevSizes = renderer.panels.map(panel => panel.size);

        renderer.updatePanelSize();

        const newSizes = renderer.panels.map(panel => panel.size);

        expect(prevSizes.every(size => size === 0)).to.be.true;
        expect(newSizes.every(size => size !== 0)).to.be.true;
      });
    });

    describe("batchInsert", () => {
      it("should insert new panels at given position", async () => {
        const flicking = await createFlicking(El.DEFAULT_HORIZONTAL);
        const renderer = new RendererImpl().init(flicking);
        const prevPanelCount = renderer.panelCount;
        const element = El.panel().el;

        renderer.batchInsert({ index: 2, elements: [element] });

        expect(renderer.panels.length).to.equal(prevPanelCount + 1);
        expect(renderer.panels[2].element).to.equal(element);
      });

      it("should return inserted panels as array", async () => {
        const flicking = await createFlicking(El.DEFAULT_HORIZONTAL);
        const renderer = new RendererImpl().init(flicking);
        const elements = range(5).map(() => El.panel().el);

        const returnVal = renderer.batchInsert({ index: 2, elements });

        expect(returnVal.map(panel => panel.element)).to.deep.equal(elements);
      });

      it("should increase pushed panel's indexes", async () => {
        const flicking = await createFlicking(El.DEFAULT_HORIZONTAL);
        const renderer = new RendererImpl().init(flicking);
        const element = El.panel().el;
        const notPushed = renderer.panels[0];
        const shouldPushed = renderer.panels.slice(1);
        const prevIndexes = shouldPushed.map(panel => panel.index);

        renderer.batchInsert({ index: 1, elements: [element] });

        expect(shouldPushed.every((panel, idx) => panel.index === prevIndexes[idx] + 1)).to.be.true;
        // Panel 0 is not pushed
        expect(notPushed.index).to.equal(0);
      });
    });
  });
});
