import Axes, { PanInput } from "@egjs/axes";

import Flicking from "../Flicking";
import Panel from "./Panel";
import PanelManager from "./PanelManager";
import StateMachine from "./StateMachine";
import { FlickingOptions, FlickingPanel, FlickingStatus, ElementLike, EventType, TriggerCallback, NeedPanelEvent, FlickingEvent, MoveTypeObjectOption } from "../types";
import { DEFAULT_VIEWPORT_CSS, DEFAULT_CAMERA_CSS, TRANSFORM, DEFAULT_OPTIONS, EVENTS, DIRECTION, STATE_TYPE } from "../consts";
import { clamp, applyCSS, toArray, parseArithmeticExpression, isBetween, isArray, parseElement } from "../utils";

export default class Viewport {
  public options: FlickingOptions;
  public stateMachine: StateMachine;
  public panelManager: PanelManager;

  private flicking: Flicking;
  private axes: Axes;
  private panInput: PanInput;

  private viewportElement: HTMLElement;
  private cameraElement: HTMLElement;

  private triggerEvent: Flicking["triggerEvent"];
  private axesHandlers: {[key: string]: any};

  private currentPanel: Panel | undefined;
  private nearestPanel: Panel | undefined;

  private state: {
    size: number;
    position: number;
    relativeHangerPosition: number;
    scrollArea: {
      prev: number;
      next: number;
    };
    translate: {
      name: string,
      has3d: boolean,
    };
    infiniteThreshold: number;
    checkedIndexes: Array<[number, number]>;
  };

  constructor(
    flicking: Flicking,
    viewportElement: HTMLElement,
    cameraElement: HTMLElement,
    options: FlickingOptions,
    triggerEvent: Flicking["triggerEvent"],
  ) {
    this.flicking = flicking;
    this.viewportElement = viewportElement;
    this.cameraElement = cameraElement;
    this.triggerEvent = triggerEvent;

    this.state = {
      size: 0,
      position: 0,
      relativeHangerPosition: 0,
      scrollArea: {
        prev: 0,
        next: 0,
      },
      translate: TRANSFORM,
      infiniteThreshold: 0,
      checkedIndexes: [],
    };
    this.options = options;
    this.stateMachine = new StateMachine();
    this.panelManager = new PanelManager(cameraElement, options);

    this.build();
  }

  public moveTo(
    panel: Panel,
    eventType: EventType["CHANGE"] | EventType["RESTORE"] | "",
    axesEvent: any,
    duration: number = this.options.duration,
  ): TriggerCallback {
    const state = this.state;
    const currentState = this.stateMachine.getState();
    const freeScroll = (this.options.moveType as MoveTypeObjectOption).type === "freeScroll";

    const currentPosition = state.position;

    let estimatedPosition = panel.getAnchorPosition() - state.relativeHangerPosition;
    estimatedPosition = this.canSetBoundMode()
      ? clamp(estimatedPosition, state.scrollArea.prev, state.scrollArea.next)
      : estimatedPosition;

    const isTrusted = axesEvent
      ? axesEvent.isTrusted
      : false;
    const direction = estimatedPosition > currentPosition
      ? DIRECTION.NEXT
      : DIRECTION.PREV;

    let eventResult: TriggerCallback;
    if (eventType === EVENTS.CHANGE) {
      eventResult = this.triggerEvent(EVENTS.CHANGE, axesEvent, isTrusted, {
        index: panel.getIndex(),
        panel,
        direction,
      });
    } else if (eventType === EVENTS.RESTORE) {
      eventResult = this.triggerEvent(EVENTS.RESTORE, axesEvent, isTrusted);
    } else {
      eventResult = {
        onSuccess(callback: () => void): TriggerCallback {
          callback();
          return this;
        },
        onStopped(): TriggerCallback {
          return this;
        },
      };
    }

    eventResult.onSuccess(() => {
      currentState.delta = 0;
      currentState.lastPosition = this.getCameraPosition();
      currentState.targetPanel = panel;
      currentState.direction = estimatedPosition > currentPosition
        ? DIRECTION.NEXT
        : DIRECTION.PREV;

      if (estimatedPosition === currentPosition) {
        // no move
        this.nearestPanel = panel;
        this.currentPanel = panel;
      }

      if (axesEvent && axesEvent.setTo) {
        // freeScroll only occurs in release events
        axesEvent.setTo({ flick: freeScroll ? axesEvent.destPos.flick : estimatedPosition }, duration);
      } else {
        this.axes.setTo({ flick: estimatedPosition }, duration);
      }
    });

    return eventResult;
  }

  public moveCamera(pos: number, axesEvent?: any): void {
    const state = this.state;
    const options = this.options;
    const transform = state.translate.name;

    // Update position & nearestPanel
    state.position = pos;
    this.nearestPanel = this.findNearestPanel();

    const nearestPanel = this.nearestPanel;
    const originalNearestPosition = nearestPanel
      ? nearestPanel.getPosition()
      : 0;

    this.checkNeedPanel(axesEvent);

    // Possibly modified after need panel, if it's looped
    const modifiedNearestPosition = nearestPanel
      ? nearestPanel.getPosition()
      : 0;

    pos += (modifiedNearestPosition - originalNearestPosition);
    state.position = pos;

    const moveVector = options.horizontal
      ? [-pos, 0] : [0, -pos];
    const moveCoord = moveVector.map(coord => `${Math.round(coord)}px`).join(", ");

    this.cameraElement.style[transform] = state.translate.has3d
      ? `translate3d(${moveCoord}, 0px)`
      : `translate(${moveCoord})`;
  }

  public stopCamera = (axesEvent: any): void => {
    if (axesEvent && axesEvent.setTo) {
      axesEvent.setTo({ flick: this.state.position }, 0);
    }

    this.stateMachine.transitTo(STATE_TYPE.IDLE);
  }

  public resize(): void {
    const panelManager = this.panelManager;

    this.updateSize();
    this.updateOriginalPanelPositions();
    this.updateAdaptiveSize();
    this.updateScrollArea();

    // Clone panels in circular mode
    if (this.options.circular && panelManager.getPanelCount() > 0) {
      this.clonePanels();
      this.updateClonedPanelPositions();
    }

    panelManager.chainAllPanels();
    this.updateCameraPosition();
  }
  // Find nearest anchor from current hanger position
  public findNearestPanel(): Panel | undefined {
    const state = this.state;
    const panelManager = this.panelManager;
    const hangerPosition = this.getHangerPosition();

    if (this.isOutOfBound()) {
      const position = state.position;

      return position <= state.scrollArea.prev
        ? panelManager.firstPanel()
        : panelManager.lastPanel();
    }

    return this.findNearestPanelAt(hangerPosition);
  }

  public findNearestPanelAt(position: number): Panel | undefined {
    const panelManager = this.panelManager;

    const allPanels = panelManager.allPanels();
    let minimumDistance = Infinity;
    let nearestPanel: Panel | undefined;

    for (const panel of allPanels) {
      if (!panel) {
        continue;
      }
      const prevPosition = panel.getPosition();
      const nextPosition = prevPosition + panel.getSize();

      // Use shortest distance from panel's range
      const distance = isBetween(position, prevPosition, nextPosition)
        ? 0
        : Math.min(
          Math.abs(prevPosition - position),
          Math.abs(nextPosition - position),
        );

      if (distance > minimumDistance) {
        break;
      } else if (distance === minimumDistance) {
        const minimumAnchorDistance = Math.abs(position - nearestPanel!.getAnchorPosition());
        const anchorDistance = Math.abs(position - panel.getAnchorPosition());

        if (anchorDistance > minimumAnchorDistance) {
          break;
        }
      }

      minimumDistance = distance;
      nearestPanel = panel;
    }

    return nearestPanel;
  }

  public findNearestIdenticalPanel(panel: Panel): Panel {
    let nearest = panel;
    let shortestDistance = Infinity;
    const hangerPosition = this.getHangerPosition();

    const identicals = panel.getIdenticalPanels();
    identicals.forEach(identical => {
      const anchorPosition = identical.getAnchorPosition();
      const distance = Math.abs(anchorPosition - hangerPosition);

      if (distance < shortestDistance) {
        nearest = identical;
        shortestDistance = distance;
      }
    });

    return nearest;
  }

  // Find shortest camera position that distance is minimum
  public findShortestPositionToPanel(panel: Panel): number {
    const state = this.state;
    const options = this.options;
    const anchorPosition = panel.getAnchorPosition();
    const hangerPosition = this.getHangerPosition();
    const distance = Math.abs(hangerPosition - anchorPosition);
    const scrollAreaSize = state.scrollArea.next - state.scrollArea.prev;

    if (!options.circular) {
      const position = anchorPosition - state.relativeHangerPosition;
      return this.canSetBoundMode()
        ? clamp(position, state.scrollArea.prev, state.scrollArea.next)
        : position;
    } else {
      // If going out of viewport border is more efficient way of moving, choose that position
      return distance <= scrollAreaSize - distance
        ? anchorPosition - state.relativeHangerPosition
        : anchorPosition > hangerPosition
          // PREV TO NEXT
          ? anchorPosition - state.relativeHangerPosition - scrollAreaSize
          // NEXT TO PREV
          : anchorPosition - state.relativeHangerPosition + scrollAreaSize;
    }
  }

  public enable(): void {
    this.panInput.enable();
  }

  public disable(): void {
    this.panInput.disable();
  }

  public insert(index: number, element: ElementLike | ElementLike[]): FlickingPanel[] {
    const lastIndex = this.panelManager.getLastIndex();

    // Index should not below 0
    if (index < 0 || index > lastIndex) {
      return [];
    }

    const state = this.state;
    const parsedElements = parseElement(element);

    const panels = parsedElements
      .map((el, idx) => new Panel(el, index + idx, this))
      .slice(0, lastIndex - index + 1);

    if (panels.length <= 0) {
      return [];
    }

    const pushedIndex = this.panelManager.insert(index, panels);

    if (!this.currentPanel) {
      this.currentPanel = panels[0];
    }

    // Update checked indexes in infinite mode
    state.checkedIndexes.forEach((indexes, idx) => {
      const [min, max] = indexes;
      // Can fill part of indexes in range
      if (isBetween(index, min, max)) {
        // Remove checked index from list
        state.checkedIndexes.splice(idx, 1);
      } else if (index < min) {
        // Push checked index
        state.checkedIndexes.splice(idx, 1, [min + pushedIndex, max + pushedIndex]);
      }
    });

    this.resize();

    return panels;
  }

  public replace(index: number, element: ElementLike | ElementLike[]): FlickingPanel[] {
    const panelManager = this.panelManager;
    const lastIndex = panelManager.getLastIndex();

    // Index should not below 0
    if (index < 0 || index > lastIndex) {
      return [];
    }

    const state = this.state;
    const parsedElements = parseElement(element);
    const panels = parsedElements
      .map((el, idx) => new Panel(el, index + idx, this))
      .slice(0, lastIndex - index + 1);

    if (panels.length <= 0) {
      return [];
    }

    panelManager.replace(index, panels);

    const currentPanel = this.currentPanel;
    if (!currentPanel) {
      this.currentPanel = panels[0];
    } else if (isBetween(currentPanel.getIndex(), index, index + panels.length - 1)) {
      // Current panel is replaced
      this.currentPanel = panelManager.get(currentPanel.getIndex());
    }

    // Update checked indexes in infinite mode
    state.checkedIndexes.forEach((indexes, idx) => {
      const [min, max] = indexes;
      // Can fill part of indexes in range
      if (index <= max && index + panels.length > min) {
        // Remove checked index from list
        state.checkedIndexes.splice(idx, 1);
      }
    });

    this.resize();

    return panels;
  }

  public remove(index: number, deleteCount: number = 1): FlickingPanel[] {
    // Index should not below 0
    index = Math.max(index, 0);

    const panelManager = this.panelManager;
    const currentIndex = this.getCurrentIndex();

    const removedPanels = panelManager.remove(index, deleteCount);
    if (isBetween(currentIndex, index, index + deleteCount - 1)) {
      // Current panel is removed
      // Use panel at removing index - 1 as new current panel if it exists
      const newCurrentIndex = Math.max(index - 1, panelManager.getRange().min);
      this.currentPanel = panelManager.get(newCurrentIndex);
    }
    this.resize();

    return removedPanels;
  }

  public updateAdaptiveSize(): void {
    const options = this.options;
    const horizontal = options.horizontal;
    const currentPanel = this.getCurrentPanel();

    if (!currentPanel) {
      return;
    }

    let sizeToApply: number;
    if (options.adaptive) {
      const panelBbox = currentPanel.getBbox();

      sizeToApply = horizontal ? panelBbox.height : panelBbox.width;
    } else {
      // Find minimum height of panels to maximum panel size
      const maximumPanelSize = this.panelManager.originalPanels().reduce((maximum, panel) => {
        const panelBbox = panel.getBbox();
        return Math.max(maximum, horizontal ? panelBbox.height : panelBbox.width);
      }, 0);

      sizeToApply = maximumPanelSize;
    }

    const viewportStyle = this.viewportElement.style;
    if (horizontal) {
      viewportStyle.height = `${sizeToApply}px`;
      viewportStyle.minHeight = "100%";
      viewportStyle.width = "100%";
    } else {
      viewportStyle.width = `${sizeToApply}px`;
      viewportStyle.minWidth = "100%";
      viewportStyle.height = "100%";
    }
  }

  public destroy(): void {
    const viewportElement = this.viewportElement;
    const wrapper = viewportElement.parentElement;

    wrapper!.removeChild(viewportElement);

    this.axes.destroy();
    this.panInput.destroy();

    this.panelManager.originalPanels().forEach(panel => {
      wrapper!.appendChild(panel.getElement());
      panel.destroy();
    });

    // release resources
    for (const x in this) {
      (this as any)[x] = null;
    }
  }

  public restore(status: FlickingStatus): void {
    const panels = status.panels;
    const cameraElement = this.cameraElement;
    const panelManager = this.panelManager;

    // Restore index
    panelManager.clear();
    cameraElement.innerHTML = status.panels.map(panel => panel.html).join("");

    this.createPanels();
    this.currentPanel = panelManager.get(status.index);

    // Reset panel index
    panelManager.originalPanels().forEach((panel, idx) => {
      panel.setIndex(panels[idx].index);
    });

    this.resize();

    this.axes.setTo({ flick: status.position }, 0);
    this.moveCamera(status.position);
  }

  public getCurrentPanel(): Panel | undefined {
    return this.currentPanel;
  }

  public getCurrentIndex(): number {
    const currentPanel = this.currentPanel;

    return currentPanel
      ? currentPanel.getIndex()
      : -1;
  }

  public getNearestPanel(): Panel | undefined {
    return this.nearestPanel;
  }

  // Get progress from nearest panel
  public getCurrentProgress(): number {
    const currentState = this.stateMachine.getState();
    let nearestPanel = currentState.playing || currentState.holding
      ? this.nearestPanel
      : this.currentPanel;

    const panelManager = this.panelManager;
    if (!nearestPanel) {
      // There're no panels
      return NaN;
    }
    const {prev: prevRange, next: nextRange} = this.getScrollArea();
    const cameraPosition = this.getCameraPosition();
    const isOutOfBound = this.isOutOfBound();
    let prevPanel = nearestPanel.prevSibling;
    let nextPanel = nearestPanel.nextSibling;
    let hangerPosition = this.getHangerPosition();
    let nearestAnchorPos = nearestPanel.getAnchorPosition();

    if (
      isOutOfBound
      && prevPanel
      && nextPanel
      && cameraPosition < nextRange
      // On the basis of anchor, prevPanel is nearestPanel.
      && (hangerPosition - prevPanel.getAnchorPosition() < nearestAnchorPos - hangerPosition)
    ) {
      nearestPanel = prevPanel;
      nextPanel = nearestPanel.nextSibling;
      prevPanel = nearestPanel.prevSibling;
      nearestAnchorPos = nearestPanel.getAnchorPosition();
    }
    const nearestIndex = nearestPanel.getIndex() + (nearestPanel.getCloneIndex() + 1) * panelManager.getPanelCount();
    const nearestSize = nearestPanel.getSize();

    if (isOutOfBound) {
      const relativeHangerPosition = this.getRelativeHangerPosition();

      if (nearestAnchorPos > nextRange + relativeHangerPosition) {
        // next bounce area: hangerPosition - relativeHangerPosition - nextRange
        hangerPosition = nearestAnchorPos + hangerPosition - relativeHangerPosition - nextRange;
      } else if (nearestAnchorPos < prevRange + relativeHangerPosition) {
        // prev bounce area: hangerPosition - relativeHangerPosition - prevRange
        hangerPosition = nearestAnchorPos + hangerPosition - relativeHangerPosition - prevRange;
      }
    }
    const hangerIsNextToNearestPanel = hangerPosition >= nearestAnchorPos;
    const gap = this.options.gap;

    let basePosition = nearestAnchorPos;
    let targetPosition = nearestAnchorPos;
    if (hangerIsNextToNearestPanel) {
      targetPosition = nextPanel
        ? nextPanel.getAnchorPosition()
        : nearestAnchorPos + nearestSize + gap;
    } else {
      basePosition = prevPanel
        ? prevPanel.getAnchorPosition()
        : basePosition = nearestAnchorPos - nearestSize - gap;
    }

    const progressBetween = (hangerPosition - basePosition) / (targetPosition - basePosition);
    const startIndex = hangerIsNextToNearestPanel
      ? nearestIndex
      : prevPanel
        ? prevPanel.getIndex()
        : nearestIndex - 1;

    return startIndex + progressBetween;
  }

  public getSize(): number {
    return this.state.size;
  }

  public getScrollArea(): { prev: number, next: number } {
    return this.state.scrollArea;
  }
  public isOutOfBound(): boolean {
    const state = this.state;
    const options = this.options;
    const scrollArea = state.scrollArea;

    return !options.circular
      && options.bound
      && (state.position <= scrollArea.prev || state.position >= scrollArea.next);
  }
  public getScrollAreaSize(): number {
    const scrollArea = this.state.scrollArea;

    return scrollArea.next - scrollArea.prev;
  }

  public getRelativeHangerPosition(): number {
    return this.state.relativeHangerPosition;
  }

  public getHangerPosition(): number {
    return this.state.position + this.state.relativeHangerPosition;
  }

  public getCameraPosition(): number {
    return this.state.position;
  }

  public setCurrentPanel(panel: Panel): void {
    this.currentPanel = panel;
  }

  public setLastIndex(index: number): void {
    const currentPanel = this.currentPanel;
    const panelManager = this.panelManager;

    panelManager.setLastIndex(index);
    if (currentPanel && currentPanel.getIndex() > index) {
      this.currentPanel = panelManager.lastPanel();
    }

    this.resize();
  }

  public connectAxesHandler(handlers: {[key: string]: (event: { [key: string]: any; }) => any}): void {
    const axes = this.axes;

    this.axesHandlers = handlers;
    axes.on(handlers);
  }

  private build(): void {
    this.applyCSSValue();
    this.setAxesInstance();
    this.createPanels();
    this.setDefaultPanel();
    this.resize();
    this.moveToDefaultPanel();
  }

  private applyCSSValue(): void {
    const options = this.options;
    const viewportElement = this.viewportElement;
    const cameraElement = this.cameraElement;
    const classPrefix = options.classPrefix;

    // Set default css values for each element
    viewportElement.className = `${classPrefix}-viewport`;
    cameraElement.className = `${classPrefix}-camera`;

    applyCSS(viewportElement, DEFAULT_VIEWPORT_CSS);
    applyCSS(cameraElement, DEFAULT_CAMERA_CSS);

    if (options.zIndex) {
      viewportElement.style.zIndex = `${options.zIndex}`;
    }
    if (options.overflow) {
      viewportElement.style.overflow = "visible";
    }
  }

  private setAxesInstance(): void {
    const state = this.state;
    const options = this.options;

    const scrollArea = state.scrollArea;
    const horizontal = options.horizontal;

    this.axes = new Axes({
      flick: {
        range: [scrollArea.prev, scrollArea.next],
        circular: options.circular,
        bounce: [0, 0], // will be updated in resize()
      },
    }, {
      easing: options.panelEffect,
      deceleration: options.deceleration,
      interruptable: true,
    });

    this.panInput = new PanInput(this.viewportElement, {
      inputType: options.inputType,
      thresholdAngle: options.thresholdAngle,
      scale: options.horizontal ? [-1, 0] : [0, -1],
    });

    this.axes.connect(horizontal ? ["flick", ""] : ["", "flick"], this.panInput);
  }

  private createPanels(): void {
    // Panel elements were attached to camera element by Flicking class
    const panelElements = this.cameraElement.children;

    // Initialize panels
    const panels = toArray(panelElements).map(
      (el: HTMLElement, idx: number) => new Panel(el, idx, this),
    );

    if (panels.length > 0) {
      this.panelManager.append(panels);
    }
  }

  private setDefaultPanel(): void {
    const options = this.options;
    const panelManager = this.panelManager;
    const indexRange = this.panelManager.getRange();
    const index = clamp(options.defaultIndex, indexRange.min, indexRange.max);

    this.currentPanel = panelManager.get(index);
  }

  private clonePanels() {
    const state = this.state;
    const panelManager = this.panelManager;

    const viewportSize = state.size;
    const firstPanel = panelManager.firstPanel();
    const lastPanel = panelManager.lastPanel() as Panel;

    // There're no panels exist
    if (!firstPanel) {
      return;
    }

    const sumOriginalPanelSize = lastPanel.getPosition() + lastPanel.getSize() - firstPanel.getPosition() + this.options.gap;
    const visibleAreaSize = viewportSize + firstPanel.getRelativeAnchorPosition();

    // For each panels, clone itself while last panel's position + size is below viewport size
    const panels = panelManager.originalPanels();

    const cloneCount = Math.ceil(visibleAreaSize / sumOriginalPanelSize);
    const prevCloneCount = panelManager.getCloneCount();

    if (cloneCount > prevCloneCount) {
      // should clone more
      for (let cloneIndex = prevCloneCount; cloneIndex < cloneCount; cloneIndex++) {
        const clones = panels.map(origPanel => {
          const clonedPanel = origPanel.clone(cloneIndex);

          this.cameraElement.appendChild(clonedPanel.getElement());
          return clonedPanel;
        });
        panelManager.insertClones(cloneIndex, 0, clones);
      }
    } else if (cloneCount < prevCloneCount) {
      // should remove some
      panelManager.removeClonesAfter(cloneCount);
    }
  }

  private moveToDefaultPanel(): void {
    const state = this.state;
    const panelManager = this.panelManager;
    const options = this.options;
    const indexRange = this.panelManager.getRange();

    const defaultIndex = clamp(options.defaultIndex, indexRange.min, indexRange.max);
    const defaultPanel = panelManager.get(defaultIndex);

    let defaultPosition = 0;
    if (defaultPanel) {
      defaultPosition = defaultPanel.getAnchorPosition() - state.relativeHangerPosition;
      defaultPosition = this.canSetBoundMode()
        ? clamp(defaultPosition, state.scrollArea.prev, state.scrollArea.next)
        : defaultPosition;
    }

    this.moveCamera(defaultPosition);
    this.axes.setTo({ flick: defaultPosition }, 0);
  }

  private canSetBoundMode(): boolean {
    const state = this.state;
    const options = this.options;
    const lastPanel = this.panelManager.lastPanel();
    if (!lastPanel) {
      return false;
    }

    const summedPanelSize = lastPanel.getPosition() + lastPanel.getSize();

    return options.bound
      && !options.circular
      && summedPanelSize >= state.size;
  }

  private updateSize(): void {
    const state = this.state;
    const options = this.options;
    const viewportElement = this.viewportElement;
    const panels = this.panelManager.originalPanels();

    if (!options.horizontal) {
      // Don't preserve previous width for adaptive resizing
      viewportElement.style.width = "";
      viewportElement.style.minWidth = "";
    }

    const bbox = viewportElement.getBoundingClientRect();

    // Update size & hanger position
    state.size = options.horizontal
      ? bbox.width
      : bbox.height;

    state.relativeHangerPosition = parseArithmeticExpression(options.hanger, state.size);
    state.infiniteThreshold = parseArithmeticExpression(options.infiniteThreshold, state.size);

    // Resize all panels
    panels.forEach(panel => {
      panel.resize();
    });
  }

  private updateOriginalPanelPositions(): void {
    const gap = this.options.gap;
    const panelManager = this.panelManager;

    const firstPanel = panelManager.firstPanel();
    const panels = panelManager.originalPanels();

    if (!firstPanel) {
      return;
    }

    const currentPanel = this.currentPanel!;
    const nearestPanel = this.nearestPanel;
    const currentState = this.stateMachine.getState();
    const scrollArea = this.state.scrollArea;

    // Update panel position && fit to wrapper
    let nextPanelPos = firstPanel.getPosition();
    let maintainingPanel: Panel = firstPanel;
    if ((currentState.holding || currentState.playing) && nearestPanel) {
      // We should maintain nearestPanel's position
      const looped = !isBetween(currentState.lastPosition + currentState.delta, scrollArea.prev, scrollArea.next);

      maintainingPanel = looped
        ? currentPanel
        : nearestPanel;
    } else if (firstPanel.getIndex() > 0) {
      maintainingPanel = currentPanel;
    }

    const panelsBeforeMaintainPanel = panels.slice(0, maintainingPanel.getIndex() + (maintainingPanel.getCloneIndex() + 1) * panels.length);
    const accumulatedSize = panelsBeforeMaintainPanel.reduce((total, panel) => {
      return total + panel.getSize() + gap;
    }, 0);

    nextPanelPos = maintainingPanel.getPosition() - accumulatedSize;

    panels.forEach(panel => {
      const newPosition = nextPanelPos;
      const currentPosition = panel.getPosition();
      const panelSize = panel.getSize();

      if (currentPosition !== newPosition) {
        panel.setPosition(newPosition);
      }
      nextPanelPos += panelSize + gap;
    });
  }

  private updateClonedPanelPositions(): void {
    const state = this.state;
    const options = this.options;
    const panelManager = this.panelManager;
    const clonedPanels = panelManager.clonedPanels()
      .filter(panel => !!panel);

    const scrollArea = state.scrollArea;

    const firstPanel = panelManager.firstPanel();
    const lastPanel = panelManager.lastPanel()!;

    if (!firstPanel) {
      return;
    }

    const sumOriginalPanelSize = lastPanel.getPosition() + lastPanel.getSize() - firstPanel.getPosition() + options.gap;

    // Locate all cloned panels linearly first
    for (const panel of clonedPanels) {
      if (!panel) {
        continue;
      }

      const origPanel = panel.getOriginalPanel();
      const cloneIndex = panel.getCloneIndex();
      const cloneBasePos = sumOriginalPanelSize * (cloneIndex + 1);
      const clonedPanelPos = cloneBasePos + origPanel.getPosition();

      panel.setPosition(clonedPanelPos);
      panel.setLoopIndex(cloneIndex + 1);
    }

    let lastReplacePosition = firstPanel.getPosition();
    // reverse() pollutes original array, so copy it with concat()
    for (const panel of clonedPanels.concat().reverse()) {
      const panelSize = panel.getSize();
      const replacePosition = lastReplacePosition - panelSize - options.gap;
      const cloneIndex = panel.getCloneIndex();
      const maxCloneCount = panelManager.getCloneCount();
      const loopIndex = cloneIndex - maxCloneCount;

      if (replacePosition + panelSize <= scrollArea.prev) {
        // Replace is not meaningful, as it won't be seen in current scroll area
        break;
      }

      panel.setPosition(replacePosition);
      panel.setLoopIndex(loopIndex);
      lastReplacePosition = replacePosition;
    }
  }

  private updateScrollArea(): void {
    const state = this.state;
    const panelManager = this.panelManager;
    const options = this.options;
    const axes = this.axes;

    // Set viewport scrollable area
    const firstPanel = panelManager.firstPanel();
    const lastPanel = panelManager.lastPanel() as Panel;
    const relativeHangerPosition = state.relativeHangerPosition;

    if (!firstPanel) {
      state.scrollArea = {
        prev: 0,
        next: 0,
      };
    } else if (this.canSetBoundMode()) {
      state.scrollArea = {
        prev: firstPanel.getPosition(),
        next: lastPanel.getPosition() + lastPanel.getSize() - state.size,
      };
    } else if (options.circular) {
      const sumOriginalPanelSize = lastPanel.getPosition() + lastPanel.getSize() - firstPanel.getPosition() + options.gap;

      // Maximum scroll extends to first clone sequence's first panel
      state.scrollArea = {
        prev: firstPanel.getAnchorPosition() - relativeHangerPosition,
        next: sumOriginalPanelSize + firstPanel.getAnchorPosition() - relativeHangerPosition,
      };
    } else {
      state.scrollArea = {
        prev: firstPanel.getAnchorPosition() - relativeHangerPosition,
        next: lastPanel.getAnchorPosition() - relativeHangerPosition,
      };
    }

    const viewportSize = state.size;
    const bounce = options.bounce;

    let parsedBounce: number[] = bounce as [number, number];
    if (isArray(bounce)) {
      parsedBounce = (bounce as string[]).map(val => parseArithmeticExpression(val, viewportSize, DEFAULT_OPTIONS.bounce as number));
    } else {
      const parsedVal = parseArithmeticExpression(bounce as number | string, viewportSize, DEFAULT_OPTIONS.bounce as number);
      parsedBounce = [parsedVal, parsedVal];
    }

    // Update axes range and bounce
    const flick = axes.axis.flick;
    flick.range = [state.scrollArea.prev, state.scrollArea.next];
    flick.bounce = parsedBounce;
  }

  // Update camera position after resizing
  private updateCameraPosition(): void {
    const state = this.state;
    const axes = this.axes;
    const currentPanel = this.getCurrentPanel();
    const currentState = this.stateMachine.getState();

    if (!currentPanel || currentState.holding || currentState.playing) {
      return;
    }

    let newPosition = currentPanel.getAnchorPosition() - state.relativeHangerPosition;

    if (this.canSetBoundMode()) {
      newPosition = clamp(newPosition, state.scrollArea.prev, state.scrollArea.next);
    }

    // Pause & resume axes to prevent axes's "change" event triggered
    // This should be done before moveCamera, as moveCamera can trigger needPanel
    this.axes.off();
    axes.setTo({
      flick: newPosition,
    }, 0);
    this.axes.on(this.axesHandlers);
    this.moveCamera(newPosition);
  }

  private checkNeedPanel(axesEvent?: any): void {
    const state = this.state;
    const options = this.options;
    const panelManager = this.panelManager;
    const currentPanel = this.currentPanel;
    const nearestPanel = this.nearestPanel;
    const currentState = this.stateMachine.getState();

    if (!options.infinite) {
      return;
    }

    const gap = options.gap;
    const infiniteThreshold = state.infiniteThreshold;
    const maxLastIndex = panelManager.getLastIndex();

    if (maxLastIndex < 0) {
      return;
    }

    if (!currentPanel || !nearestPanel) {
      // There're no panels
      this.triggerNeedPanel({
        axesEvent,
        siblingPanel: null,
        direction: null,
        indexRange: {
          min: 0,
          max: maxLastIndex,
          length: maxLastIndex + 1,
        },
      });
      return;
    }

    const originalNearestPosition = nearestPanel.getPosition();

    // Check next direction
    let checkingPanel: Panel | null = !currentState.holding && !currentState.playing
      ? currentPanel
      : nearestPanel;
    while (checkingPanel) {
      const currentIndex = checkingPanel.getIndex();
      const nextSibling = checkingPanel.nextSibling;
      let lastPanel = panelManager.lastPanel()!;
      let atLastPanel = currentIndex === lastPanel.getIndex();
      const nextIndex = !atLastPanel && nextSibling
        ? nextSibling.getIndex()
        : maxLastIndex + 1;
      const currentNearestPosition = nearestPanel.getPosition();
      const panelRight = checkingPanel.getPosition() + checkingPanel.getSize() - (currentNearestPosition - originalNearestPosition);
      const cameraNext = state.position + state.size;

      // There're empty panels between
      const emptyPanelExistsBetween = (nextIndex - currentIndex > 1);
      // Expected prev panel's left position is smaller than camera position
      const overThreshold = panelRight + gap - infiniteThreshold <= cameraNext;

      if (emptyPanelExistsBetween && overThreshold) {
        this.triggerNeedPanel({
          axesEvent,
          siblingPanel: checkingPanel,
          direction: DIRECTION.NEXT,
          indexRange: {
            min: currentIndex + 1,
            max: nextIndex - 1,
            length: nextIndex - currentIndex - 1,
          },
        });
      }

      // Trigger needPanel in circular & at max panel index
      if (options.circular && currentIndex === maxLastIndex && overThreshold) {
        const firstPanel = panelManager.firstPanel()!;
        const firstIndex = firstPanel.getIndex();

        if (firstIndex > 0) {
          this.triggerNeedPanel({
            axesEvent,
            siblingPanel: checkingPanel,
            direction: DIRECTION.NEXT,
            indexRange: {
              min: 0,
              max: firstIndex - 1,
              length: firstIndex,
            },
          });
        }
      }

      // Check whether insertion happened
      lastPanel = panelManager.lastPanel()!;
      atLastPanel = currentIndex === lastPanel.getIndex();

      if (atLastPanel || !overThreshold) {
        break;
      }

      checkingPanel = checkingPanel.nextSibling;
    }

    // Check prev direction
    checkingPanel = nearestPanel;
    while (checkingPanel) {
      const cameraPrev = state.position;
      const checkingIndex = checkingPanel.getIndex();
      const prevSibling = checkingPanel.prevSibling;
      let firstPanel = panelManager.firstPanel()!;
      let atFirstPanel = checkingIndex === firstPanel.getIndex();
      const prevIndex = !atFirstPanel && prevSibling
        ? prevSibling.getIndex()
        : -1;
      const currentNearestPosition = nearestPanel.getPosition();
      const panelLeft = checkingPanel.getPosition() - (currentNearestPosition - originalNearestPosition);

      // There're empty panels between
      const emptyPanelExistsBetween = checkingIndex - prevIndex > 1;
      // Expected prev panel's right position is smaller than camera position
      const overThreshold = panelLeft - gap + infiniteThreshold >= cameraPrev;
      if (emptyPanelExistsBetween && overThreshold) {
        this.triggerNeedPanel({
          axesEvent,
          siblingPanel: checkingPanel,
          direction: DIRECTION.PREV,
          indexRange: {
            min: prevIndex + 1,
            max: checkingIndex - 1,
            length: checkingIndex - prevIndex - 1,
          },
        });
      }

      // Trigger needPanel in circular & at panel 0
      if (options.circular && checkingIndex === 0 && overThreshold) {
        const lastPanel = panelManager.lastPanel()!;
        const lastIndex = lastPanel.getIndex();

        if (lastIndex < maxLastIndex) {
          this.triggerNeedPanel({
            axesEvent,
            siblingPanel: checkingPanel,
            direction: DIRECTION.PREV,
            indexRange: {
              min: lastIndex + 1,
              max: maxLastIndex,
              length: maxLastIndex - lastIndex,
            },
          });
        }
      }

      // Check whether insertion happened
      firstPanel = panelManager.firstPanel()!;
      atFirstPanel = checkingIndex === firstPanel.getIndex();

      // Looped in circular mode
      if (atFirstPanel || !overThreshold) {
        break;
      }

      checkingPanel = checkingPanel.prevSibling;
    }
  }

  private triggerNeedPanel(params: {
    axesEvent: any;
    siblingPanel: Panel | null,
    direction: FlickingEvent["direction"];
    indexRange: NeedPanelEvent["range"];
  }): void {
    const { axesEvent, siblingPanel, direction, indexRange } = params;
    const checkedIndexes = this.state.checkedIndexes;
    const alreadyTriggered = checkedIndexes.some(([min, max]) => min === indexRange.min || max === indexRange.max);
    const hasHandler = this.flicking.hasOn(EVENTS.NEED_PANEL);

    if (alreadyTriggered || !hasHandler) {
      return;
    }

    // Should done before triggering event, as we can directly add panels by event callback
    checkedIndexes.push([indexRange.min, indexRange.max]);

    const index = siblingPanel
      ? siblingPanel.getIndex()
      : 0;
    const isTrusted = axesEvent
      ? axesEvent.isTrusted
      : false;

    this.triggerEvent(
      EVENTS.NEED_PANEL,
      axesEvent,
      isTrusted,
      {
        index,
        panel: siblingPanel,
        direction,
        range: indexRange,
      } as Partial<NeedPanelEvent>,
    );
  }
}