import React from "react";

import rough from "roughjs/bin/rough";
import { RoughCanvas } from "roughjs/bin/canvas";
import { Point } from "roughjs/bin/geometry";

import {
  newElement,
  newTextElement,
  duplicateElement,
  resizeTest,
  normalizeResizeHandle,
  isInvisiblySmallElement,
  isTextElement,
  textWysiwyg,
  getCommonBounds,
  getCursorForResizingElement,
  getPerfectElementSize,
  normalizeDimensions,
} from "../element";
import {
  deleteSelectedElements,
  getElementsWithinSelection,
  isOverScrollBars,
  getElementAtPosition,
  createScene,
  getElementContainingPosition,
  getNormalizedZoom,
  getSelectedElements,
  isSomeElementSelected,
} from "../scene";
import { saveToLocalStorage, loadScene, loadFromBlob } from "../data";

import { renderScene } from "../renderer";
import { AppState, GestureEvent, Gesture } from "../types";
import { ExcalidrawElement } from "../element/types";

import {
  isWritableElement,
  isInputLike,
  isToolIcon,
  debounce,
  distance,
  distance2d,
  resetCursor,
  viewportCoordsToSceneCoords,
  sceneCoordsToViewportCoords,
} from "../utils";
import { KEYS, isArrowKey } from "../keys";

import { findShapeByKey, shapesShortcutKeys } from "../shapes";
import { createHistory } from "../history";

import ContextMenu from "./ContextMenu";

import { getElementWithResizeHandler } from "../element/resizeTest";
import { ActionManager } from "../actions/manager";
import "../actions";
import { actions } from "../actions/register";

import { ActionResult } from "../actions/types";
import { getDefaultAppState } from "../appState";
import { t, getLanguage } from "../i18n";

import { copyToAppClipboard, getClipboardContent } from "../clipboard";
import { normalizeScroll } from "../scene";
import { getCenter, getDistance } from "../gesture";
import { createUndoAction, createRedoAction } from "../actions/actionHistory";
import {
  CURSOR_TYPE,
  ELEMENT_SHIFT_TRANSLATE_AMOUNT,
  ELEMENT_TRANSLATE_AMOUNT,
  POINTER_BUTTON,
  DRAGGING_THRESHOLD,
  TEXT_TO_CENTER_SNAP_THRESHOLD,
} from "../constants";
import { LayerUI } from "./LayerUI";
import { ScrollBars } from "../scene/types";
import { invalidateShapeForElement } from "../renderer/renderElement";

// -----------------------------------------------------------------------------
// TEST HOOKS
// -----------------------------------------------------------------------------

declare global {
  interface Window {
    __TEST__: {
      elements: typeof elements;
      appState: AppState;
    };
  }
}

if (process.env.NODE_ENV === "test") {
  window.__TEST__ = {} as Window["__TEST__"];
}

// -----------------------------------------------------------------------------

let { elements } = createScene();

if (process.env.NODE_ENV === "test") {
  Object.defineProperty(window.__TEST__, "elements", {
    get() {
      return elements;
    },
  });
}

const { history } = createHistory();

let cursorX = 0;
let cursorY = 0;
let isHoldingSpace: boolean = false;
let isPanning: boolean = false;
let isDraggingScrollBar: boolean = false;
let currentScrollBars: ScrollBars = { horizontal: null, vertical: null };

let lastPointerUp: ((event: any) => void) | null = null;
const gesture: Gesture = {
  pointers: new Map(),
  lastCenter: null,
  initialDistance: null,
  initialScale: null,
};

function setCursorForShape(shape: string) {
  if (shape === "selection") {
    resetCursor();
  } else {
    document.documentElement.style.cursor =
      shape === "text" ? CURSOR_TYPE.TEXT : CURSOR_TYPE.CROSSHAIR;
  }
}

export class App extends React.Component<any, AppState> {
  canvas: HTMLCanvasElement | null = null;
  rc: RoughCanvas | null = null;

  actionManager: ActionManager;
  canvasOnlyActions = ["selectAll"];
  constructor(props: any) {
    super(props);
    this.actionManager = new ActionManager(
      this.syncActionResult,
      () => this.state,
      () => elements,
    );
    this.actionManager.registerAll(actions);

    this.actionManager.registerAction(createUndoAction(history));
    this.actionManager.registerAction(createRedoAction(history));
  }

  private syncActionResult = (
    res: ActionResult,
    commitToHistory: boolean = true,
  ) => {
    if (this.unmounted) {
      return;
    }
    if (res.elements) {
      elements = res.elements;
      if (commitToHistory) {
        history.resumeRecording();
      }
      this.setState({});
    }

    if (res.appState) {
      if (commitToHistory) {
        history.resumeRecording();
      }
      this.setState({ ...res.appState });
    }
  };

  private onCut = (event: ClipboardEvent) => {
    if (isWritableElement(event.target)) {
      return;
    }
    copyToAppClipboard(elements, this.state);
    const { elements: nextElements, appState } = deleteSelectedElements(
      elements,
      this.state,
    );
    elements = nextElements;
    history.resumeRecording();
    this.setState({ ...appState });
    event.preventDefault();
  };
  private onCopy = (event: ClipboardEvent) => {
    if (isWritableElement(event.target)) {
      return;
    }
    copyToAppClipboard(elements, this.state);
    event.preventDefault();
  };

  private onUnload = () => {
    isHoldingSpace = false;
    this.saveDebounced();
    this.saveDebounced.flush();
  };

  private disableEvent: EventHandlerNonNull = event => {
    event.preventDefault();
  };

  private unmounted = false;
  public async componentDidMount() {
    if (process.env.NODE_ENV === "test") {
      Object.defineProperty(window.__TEST__, "appState", {
        configurable: true,
        get: () => {
          return this.state;
        },
      });
    }

    document.addEventListener("copy", this.onCopy);
    document.addEventListener("paste", this.pasteFromClipboard);
    document.addEventListener("cut", this.onCut);

    document.addEventListener("keydown", this.onKeyDown, false);
    document.addEventListener("keyup", this.onKeyUp, { passive: true });
    document.addEventListener("mousemove", this.updateCurrentCursorPosition);
    window.addEventListener("resize", this.onResize, false);
    window.addEventListener("unload", this.onUnload, false);
    window.addEventListener("blur", this.onUnload, false);
    window.addEventListener("dragover", this.disableEvent, false);
    window.addEventListener("drop", this.disableEvent, false);

    // Safari-only desktop pinch zoom
    document.addEventListener(
      "gesturestart",
      this.onGestureStart as any,
      false,
    );
    document.addEventListener(
      "gesturechange",
      this.onGestureChange as any,
      false,
    );
    document.addEventListener("gestureend", this.onGestureEnd as any, false);

    const searchParams = new URLSearchParams(window.location.search);
    const id = searchParams.get("id");

    if (id) {
      // Backwards compatibility with legacy url format
      const scene = await loadScene(id);
      this.syncActionResult(scene);
    } else {
      const match = window.location.hash.match(
        /^#json=([0-9]+),([a-zA-Z0-9_-]+)$/,
      );
      if (match) {
        const scene = await loadScene(match[1], match[2]);
        this.syncActionResult(scene);
      } else {
        const scene = await loadScene(null);
        this.syncActionResult(scene);
      }
    }
  }

  public componentWillUnmount() {
    this.unmounted = true;
    document.removeEventListener("copy", this.onCopy);
    document.removeEventListener("paste", this.pasteFromClipboard);
    document.removeEventListener("cut", this.onCut);

    document.removeEventListener("keydown", this.onKeyDown, false);
    document.removeEventListener(
      "mousemove",
      this.updateCurrentCursorPosition,
      false,
    );
    document.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("resize", this.onResize, false);
    window.removeEventListener("unload", this.onUnload, false);
    window.removeEventListener("blur", this.onUnload, false);
    window.removeEventListener("dragover", this.disableEvent, false);
    window.removeEventListener("drop", this.disableEvent, false);

    document.removeEventListener(
      "gesturestart",
      this.onGestureStart as any,
      false,
    );
    document.removeEventListener(
      "gesturechange",
      this.onGestureChange as any,
      false,
    );
    document.removeEventListener("gestureend", this.onGestureEnd as any, false);
  }

  public state: AppState = getDefaultAppState();

  private onResize = () => {
    elements.forEach(element => invalidateShapeForElement(element));
    this.setState({});
  };

  private updateCurrentCursorPosition = (event: MouseEvent) => {
    cursorX = event.x;
    cursorY = event.y;
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (
      (isWritableElement(event.target) && event.key !== KEYS.ESCAPE) ||
      // case: using arrows to move between buttons
      (isArrowKey(event.key) && isInputLike(event.target))
    ) {
      return;
    }

    if (this.actionManager.handleKeyDown(event)) {
      return;
    }

    const shape = findShapeByKey(event.key);

    if (isArrowKey(event.key)) {
      const step = event.shiftKey
        ? ELEMENT_SHIFT_TRANSLATE_AMOUNT
        : ELEMENT_TRANSLATE_AMOUNT;
      elements = elements.map(el => {
        if (this.state.selectedElementIds[el.id]) {
          const element = { ...el };
          if (event.key === KEYS.ARROW_LEFT) {
            element.x -= step;
          } else if (event.key === KEYS.ARROW_RIGHT) {
            element.x += step;
          } else if (event.key === KEYS.ARROW_UP) {
            element.y -= step;
          } else if (event.key === KEYS.ARROW_DOWN) {
            element.y += step;
          }
          return element;
        }
        return el;
      });
      this.setState({});
      event.preventDefault();
    } else if (
      shapesShortcutKeys.includes(event.key.toLowerCase()) &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      this.state.draggingElement === null
    ) {
      this.selectShapeTool(shape);
    } else if (event.key === KEYS.SPACE && gesture.pointers.size === 0) {
      isHoldingSpace = true;
      document.documentElement.style.cursor = CURSOR_TYPE.GRABBING;
    }
  };

  private onKeyUp = (event: KeyboardEvent) => {
    if (event.key === KEYS.SPACE) {
      if (this.state.elementType === "selection") {
        resetCursor();
      } else {
        document.documentElement.style.cursor =
          this.state.elementType === "text"
            ? CURSOR_TYPE.TEXT
            : CURSOR_TYPE.CROSSHAIR;
        this.setState({ selectedElementIds: {} });
      }
      isHoldingSpace = false;
    }
  };

  private copyToAppClipboard = () => {
    copyToAppClipboard(elements, this.state);
  };

  private pasteFromClipboard = async (event: ClipboardEvent | null) => {
    // #686
    const target = document.activeElement;
    const elementUnderCursor = document.elementFromPoint(cursorX, cursorY);
    if (
      // if no ClipboardEvent supplied, assume we're pasting via contextMenu
      //  thus these checks don't make sense
      !event ||
      (elementUnderCursor instanceof HTMLCanvasElement &&
        !isWritableElement(target))
    ) {
      const data = await getClipboardContent(event);
      if (data.elements) {
        this.addElementsFromPaste(data.elements);
      } else if (data.text) {
        const { x, y } = viewportCoordsToSceneCoords(
          { clientX: cursorX, clientY: cursorY },
          this.state,
          this.canvas,
        );

        const element = newTextElement(
          newElement(
            "text",
            x,
            y,
            this.state.currentItemStrokeColor,
            this.state.currentItemBackgroundColor,
            this.state.currentItemFillStyle,
            this.state.currentItemStrokeWidth,
            this.state.currentItemRoughness,
            this.state.currentItemOpacity,
          ),
          data.text,
          this.state.currentItemFont,
        );

        elements = [...elements, element];
        this.setState({ selectedElementIds: { [element.id]: true } });
        history.resumeRecording();
      }
      this.selectShapeTool("selection");
      event?.preventDefault();
    }
  };

  private selectShapeTool(elementType: AppState["elementType"]) {
    if (!isHoldingSpace) {
      setCursorForShape(elementType);
    }
    if (isToolIcon(document.activeElement)) {
      document.activeElement.blur();
    }
    if (elementType !== "selection") {
      this.setState({ elementType, selectedElementIds: {} });
    } else {
      this.setState({ elementType });
    }
  }

  private onGestureStart = (event: GestureEvent) => {
    event.preventDefault();
    gesture.initialScale = this.state.zoom;
  };
  private onGestureChange = (event: GestureEvent) => {
    event.preventDefault();

    this.setState({
      zoom: getNormalizedZoom(gesture.initialScale! * event.scale),
    });
  };
  private onGestureEnd = (event: GestureEvent) => {
    event.preventDefault();
    gesture.initialScale = null;
  };

  setAppState = (obj: any) => {
    this.setState(obj);
  };

  setElements = (elements_: readonly ExcalidrawElement[]) => {
    elements = elements_;
    this.setState({});
  };

  removePointer = (event: React.PointerEvent<HTMLElement>) => {
    gesture.pointers.delete(event.pointerId);
  };

  public render() {
    const canvasDOMWidth = window.innerWidth;
    const canvasDOMHeight = window.innerHeight;

    const canvasScale = window.devicePixelRatio;

    const canvasWidth = canvasDOMWidth * canvasScale;
    const canvasHeight = canvasDOMHeight * canvasScale;

    return (
      <div className="container">
        <LayerUI
          canvas={this.canvas}
          appState={this.state}
          setAppState={this.setAppState}
          actionManager={this.actionManager}
          elements={elements}
          setElements={this.setElements}
          language={getLanguage()}
        />
        <main>
          <canvas
            id="canvas"
            style={{
              width: canvasDOMWidth,
              height: canvasDOMHeight,
            }}
            width={canvasWidth}
            height={canvasHeight}
            ref={canvas => {
              // canvas is null when unmounting
              if (canvas !== null) {
                this.canvas = canvas;
                this.rc = rough.canvas(this.canvas);

                this.canvas.addEventListener("wheel", this.handleWheel, {
                  passive: false,
                });

                this.canvas
                  .getContext("2d")
                  ?.setTransform(canvasScale, 0, 0, canvasScale, 0, 0);
              } else {
                this.canvas?.removeEventListener("wheel", this.handleWheel);
              }
            }}
            onContextMenu={event => {
              event.preventDefault();

              const { x, y } = viewportCoordsToSceneCoords(
                event,
                this.state,
                this.canvas,
              );

              const element = getElementAtPosition(
                elements,
                this.state,
                x,
                y,
                this.state.zoom,
              );
              if (!element) {
                ContextMenu.push({
                  options: [
                    navigator.clipboard && {
                      label: t("labels.paste"),
                      action: () => this.pasteFromClipboard(null),
                    },
                    ...this.actionManager.getContextMenuItems(action =>
                      this.canvasOnlyActions.includes(action.name),
                    ),
                  ],
                  top: event.clientY,
                  left: event.clientX,
                });
                return;
              }

              if (!this.state.selectedElementIds[element.id]) {
                this.setState({ selectedElementIds: { [element.id]: true } });
              }

              ContextMenu.push({
                options: [
                  navigator.clipboard && {
                    label: t("labels.copy"),
                    action: this.copyToAppClipboard,
                  },
                  navigator.clipboard && {
                    label: t("labels.paste"),
                    action: () => this.pasteFromClipboard(null),
                  },
                  ...this.actionManager.getContextMenuItems(
                    action => !this.canvasOnlyActions.includes(action.name),
                  ),
                ],
                top: event.clientY,
                left: event.clientX,
              });
            }}
            onPointerDown={this.handleCanvasPointerDown}
            onDoubleClick={this.handleCanvasDoubleClick}
            onPointerMove={this.handleCanvasPointerMove}
            onPointerUp={this.removePointer}
            onPointerCancel={this.removePointer}
            onDrop={event => {
              const file = event.dataTransfer.files[0];
              if (
                file?.type === "application/json" ||
                file?.name.endsWith(".excalidraw")
              ) {
                loadFromBlob(file)
                  .then(({ elements, appState }) =>
                    this.syncActionResult({ elements, appState }),
                  )
                  .catch(error => console.error(error));
              }
            }}
          >
            {t("labels.drawingCanvas")}
          </canvas>
        </main>
      </div>
    );
  }

  private handleCanvasDoubleClick = (
    event: React.MouseEvent<HTMLCanvasElement>,
  ) => {
    resetCursor();

    const { x, y } = viewportCoordsToSceneCoords(
      event,
      this.state,
      this.canvas,
    );

    const elementAtPosition = getElementAtPosition(
      elements,
      this.state,
      x,
      y,
      this.state.zoom,
    );

    const element =
      elementAtPosition && isTextElement(elementAtPosition)
        ? elementAtPosition
        : newTextElement(
            newElement(
              "text",
              x,
              y,
              this.state.currentItemStrokeColor,
              this.state.currentItemBackgroundColor,
              this.state.currentItemFillStyle,
              this.state.currentItemStrokeWidth,
              this.state.currentItemRoughness,
              this.state.currentItemOpacity,
            ),
            "", // default text
            this.state.currentItemFont, // default font
          );

    this.setState({ editingElement: element });

    let textX = event.clientX;
    let textY = event.clientY;

    if (elementAtPosition && isTextElement(elementAtPosition)) {
      elements = elements.filter(
        element => element.id !== elementAtPosition.id,
      );
      this.setState({});

      const centerElementX = elementAtPosition.x + elementAtPosition.width / 2;
      const centerElementY = elementAtPosition.y + elementAtPosition.height / 2;

      const {
        x: centerElementXInViewport,
        y: centerElementYInViewport,
      } = sceneCoordsToViewportCoords(
        { sceneX: centerElementX, sceneY: centerElementY },
        this.state,
        this.canvas,
      );

      textX = centerElementXInViewport;
      textY = centerElementYInViewport;

      // x and y will change after calling newTextElement function
      element.x = centerElementX;
      element.y = centerElementY;
    } else if (!event.altKey) {
      const snappedToCenterPosition = this.getTextWysiwygSnappedToCenterPosition(
        x,
        y,
      );

      if (snappedToCenterPosition) {
        element.x = snappedToCenterPosition.elementCenterX;
        element.y = snappedToCenterPosition.elementCenterY;
        textX = snappedToCenterPosition.wysiwygX;
        textY = snappedToCenterPosition.wysiwygY;
      }
    }

    const resetSelection = () => {
      this.setState({
        draggingElement: null,
        editingElement: null,
      });
    };

    textWysiwyg({
      initText: element.text,
      x: textX,
      y: textY,
      strokeColor: element.strokeColor,
      font: element.font,
      opacity: this.state.currentItemOpacity,
      zoom: this.state.zoom,
      onSubmit: text => {
        if (text) {
          elements = [
            ...elements,
            {
              // we need to recreate the element to update dimensions &
              //  position
              ...newTextElement(element, text, element.font),
            },
          ];
        }
        this.setState(prevState => ({
          selectedElementIds: {
            ...prevState.selectedElementIds,
            [element.id]: true,
          },
        }));
        history.resumeRecording();
        resetSelection();
      },
      onCancel: () => {
        resetSelection();
      },
    });
  };

  private handleCanvasPointerMove = (
    event: React.PointerEvent<HTMLCanvasElement>,
  ) => {
    gesture.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (gesture.pointers.size === 2) {
      const center = getCenter(gesture.pointers);
      const deltaX = center.x - gesture.lastCenter!.x;
      const deltaY = center.y - gesture.lastCenter!.y;
      gesture.lastCenter = center;

      const distance = getDistance(Array.from(gesture.pointers.values()));
      const scaleFactor = distance / gesture.initialDistance!;

      this.setState({
        scrollX: normalizeScroll(this.state.scrollX + deltaX / this.state.zoom),
        scrollY: normalizeScroll(this.state.scrollY + deltaY / this.state.zoom),
        zoom: getNormalizedZoom(gesture.initialScale! * scaleFactor),
      });
    } else {
      gesture.lastCenter = gesture.initialDistance = gesture.initialScale = null;
    }

    if (isHoldingSpace || isPanning || isDraggingScrollBar) {
      return;
    }
    const {
      isOverHorizontalScrollBar,
      isOverVerticalScrollBar,
    } = isOverScrollBars(currentScrollBars, event.clientX, event.clientY);
    const isOverScrollBar =
      isOverVerticalScrollBar || isOverHorizontalScrollBar;
    if (!this.state.draggingElement && !this.state.multiElement) {
      if (isOverScrollBar) {
        resetCursor();
      } else {
        setCursorForShape(this.state.elementType);
      }
    }

    const { x, y } = viewportCoordsToSceneCoords(
      event,
      this.state,
      this.canvas,
    );
    if (this.state.multiElement) {
      const { multiElement } = this.state;
      const originX = multiElement.x;
      const originY = multiElement.y;
      const points = multiElement.points;
      const pnt = points[points.length - 1];
      pnt[0] = x - originX;
      pnt[1] = y - originY;
      invalidateShapeForElement(multiElement);
      this.setState({});
      return;
    }

    const hasDeselectedButton = Boolean(event.buttons);
    if (hasDeselectedButton || this.state.elementType !== "selection") {
      return;
    }

    const selectedElements = getSelectedElements(elements, this.state);
    if (selectedElements.length === 1 && !isOverScrollBar) {
      const resizeElement = getElementWithResizeHandler(
        elements,
        this.state,
        { x, y },
        this.state.zoom,
        event.pointerType,
      );
      if (resizeElement && resizeElement.resizeHandle) {
        document.documentElement.style.cursor = getCursorForResizingElement(
          resizeElement,
        );
        return;
      }
    }
    const hitElement = getElementAtPosition(
      elements,
      this.state,
      x,
      y,
      this.state.zoom,
    );
    document.documentElement.style.cursor =
      hitElement && !isOverScrollBar ? "move" : "";
  };

  private handleCanvasPointerDown = (
    event: React.PointerEvent<HTMLCanvasElement>,
  ) => {
    if (lastPointerUp !== null) {
      // Unfortunately, sometimes we don't get a pointerup after a pointerdown,
      // this can happen when a contextual menu or alert is triggered. In order to avoid
      // being in a weird state, we clean up on the next pointerdown
      lastPointerUp(event);
    }

    if (isPanning) {
      return;
    }

    this.setState({ lastPointerDownWith: event.pointerType });

    // pan canvas on wheel button drag or space+drag
    if (
      gesture.pointers.size === 0 &&
      (event.button === POINTER_BUTTON.WHEEL ||
        (event.button === POINTER_BUTTON.MAIN && isHoldingSpace))
    ) {
      isPanning = true;
      document.documentElement.style.cursor = CURSOR_TYPE.GRABBING;
      let { clientX: lastX, clientY: lastY } = event;
      const onPointerMove = (event: PointerEvent) => {
        const deltaX = lastX - event.clientX;
        const deltaY = lastY - event.clientY;
        lastX = event.clientX;
        lastY = event.clientY;

        this.setState({
          scrollX: normalizeScroll(
            this.state.scrollX - deltaX / this.state.zoom,
          ),
          scrollY: normalizeScroll(
            this.state.scrollY - deltaY / this.state.zoom,
          ),
        });
      };
      const teardown = (lastPointerUp = () => {
        lastPointerUp = null;
        isPanning = false;
        if (!isHoldingSpace) {
          setCursorForShape(this.state.elementType);
        }
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", teardown);
        window.removeEventListener("blur", teardown);
      });
      window.addEventListener("blur", teardown);
      window.addEventListener("pointermove", onPointerMove, {
        passive: true,
      });
      window.addEventListener("pointerup", teardown);
      return;
    }

    // only handle left mouse button or touch
    if (
      event.button !== POINTER_BUTTON.MAIN &&
      event.button !== POINTER_BUTTON.TOUCH
    ) {
      return;
    }

    gesture.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (gesture.pointers.size === 2) {
      gesture.lastCenter = getCenter(gesture.pointers);
      gesture.initialScale = this.state.zoom;
      gesture.initialDistance = getDistance(
        Array.from(gesture.pointers.values()),
      );
    }

    // fixes pointermove causing selection of UI texts #32
    event.preventDefault();
    // Preventing the event above disables default behavior
    //  of defocusing potentially focused element, which is what we
    //  want when clicking inside the canvas.
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    // don't select while panning
    if (gesture.pointers.size > 1) {
      return;
    }

    // Handle scrollbars dragging
    const {
      isOverHorizontalScrollBar,
      isOverVerticalScrollBar,
    } = isOverScrollBars(currentScrollBars, event.clientX, event.clientY);

    const { x, y } = viewportCoordsToSceneCoords(
      event,
      this.state,
      this.canvas,
    );
    let lastX = x;
    let lastY = y;

    if (
      (isOverHorizontalScrollBar || isOverVerticalScrollBar) &&
      !this.state.multiElement
    ) {
      isDraggingScrollBar = true;
      lastX = event.clientX;
      lastY = event.clientY;
      const onPointerMove = (event: PointerEvent) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }

        if (isOverHorizontalScrollBar) {
          const x = event.clientX;
          const dx = x - lastX;
          this.setState({
            scrollX: normalizeScroll(this.state.scrollX - dx / this.state.zoom),
          });
          lastX = x;
          return;
        }

        if (isOverVerticalScrollBar) {
          const y = event.clientY;
          const dy = y - lastY;
          this.setState({
            scrollY: normalizeScroll(this.state.scrollY - dy / this.state.zoom),
          });
          lastY = y;
        }
      };

      const onPointerUp = () => {
        isDraggingScrollBar = false;
        setCursorForShape(this.state.elementType);
        lastPointerUp = null;
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };

      lastPointerUp = onPointerUp;

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      return;
    }

    const originX = x;
    const originY = y;

    let element = newElement(
      this.state.elementType,
      x,
      y,
      this.state.currentItemStrokeColor,
      this.state.currentItemBackgroundColor,
      this.state.currentItemFillStyle,
      this.state.currentItemStrokeWidth,
      this.state.currentItemRoughness,
      this.state.currentItemOpacity,
    );

    if (isTextElement(element)) {
      element = newTextElement(element, "", this.state.currentItemFont);
    }

    type ResizeTestType = ReturnType<typeof resizeTest>;
    let resizeHandle: ResizeTestType = false;
    let isResizingElements = false;
    let draggingOccurred = false;
    let hitElement: ExcalidrawElement | null = null;
    let elementIsAddedToSelection = false;
    if (this.state.elementType === "selection") {
      const resizeElement = getElementWithResizeHandler(
        elements,
        this.state,
        { x, y },
        this.state.zoom,
        event.pointerType,
      );

      const selectedElements = getSelectedElements(elements, this.state);
      if (selectedElements.length === 1 && resizeElement) {
        this.setState({
          resizingElement: resizeElement ? resizeElement.element : null,
        });

        resizeHandle = resizeElement.resizeHandle;
        document.documentElement.style.cursor = getCursorForResizingElement(
          resizeElement,
        );
        isResizingElements = true;
      } else {
        hitElement = getElementAtPosition(
          elements,
          this.state,
          x,
          y,
          this.state.zoom,
        );
        // clear selection if shift is not clicked
        if (
          !(hitElement && this.state.selectedElementIds[hitElement.id]) &&
          !event.shiftKey
        ) {
          this.setState({ selectedElementIds: {} });
        }

        // If we click on something
        if (hitElement) {
          // deselect if item is selected
          // if shift is not clicked, this will always return true
          // otherwise, it will trigger selection based on current
          // state of the box
          if (!this.state.selectedElementIds[hitElement.id]) {
            this.setState(prevState => ({
              selectedElementIds: {
                ...prevState.selectedElementIds,
                [hitElement!.id]: true,
              },
            }));
            elements = elements.slice();
            elementIsAddedToSelection = true;
          }

          // We duplicate the selected element if alt is pressed on pointer down
          if (event.altKey) {
            // Move the currently selected elements to the top of the z index stack, and
            // put the duplicates where the selected elements used to be.
            const nextElements = [];
            const elementsToAppend = [];
            for (const element of elements) {
              if (this.state.selectedElementIds[element.id]) {
                nextElements.push(duplicateElement(element));
                elementsToAppend.push(element);
              } else {
                nextElements.push(element);
              }
            }
            elements = [...nextElements, ...elementsToAppend];
          }
        }
      }
    } else {
      this.setState({ selectedElementIds: {} });
    }

    if (isTextElement(element)) {
      // if we're currently still editing text, clicking outside
      //  should only finalize it, not create another (irrespective
      //  of state.elementLocked)
      if (this.state.editingElement?.type === "text") {
        return;
      }
      if (elementIsAddedToSelection) {
        element = hitElement!;
      }
      let textX = event.clientX;
      let textY = event.clientY;
      if (!event.altKey) {
        const snappedToCenterPosition = this.getTextWysiwygSnappedToCenterPosition(
          x,
          y,
        );
        if (snappedToCenterPosition) {
          element.x = snappedToCenterPosition.elementCenterX;
          element.y = snappedToCenterPosition.elementCenterY;
          textX = snappedToCenterPosition.wysiwygX;
          textY = snappedToCenterPosition.wysiwygY;
        }
      }

      const resetSelection = () => {
        this.setState({
          draggingElement: null,
          editingElement: null,
        });
      };

      textWysiwyg({
        initText: "",
        x: textX,
        y: textY,
        strokeColor: this.state.currentItemStrokeColor,
        opacity: this.state.currentItemOpacity,
        font: this.state.currentItemFont,
        zoom: this.state.zoom,
        onSubmit: text => {
          if (text) {
            elements = [
              ...elements,
              {
                ...newTextElement(element, text, this.state.currentItemFont),
              },
            ];
          }
          this.setState(prevState => ({
            selectedElementIds: {
              ...prevState.selectedElementIds,
              [element.id]: true,
            },
          }));
          if (this.state.elementLocked) {
            setCursorForShape(this.state.elementType);
          }
          history.resumeRecording();
          resetSelection();
        },
        onCancel: () => {
          resetSelection();
        },
      });
      resetCursor();
      if (!this.state.elementLocked) {
        this.setState({
          editingElement: element,
          elementType: "selection",
        });
      } else {
        this.setState({
          editingElement: element,
        });
      }
      return;
    } else if (
      this.state.elementType === "arrow" ||
      this.state.elementType === "line"
    ) {
      if (this.state.multiElement) {
        const { multiElement } = this.state;
        const { x: rx, y: ry } = multiElement;
        this.setState(prevState => ({
          selectedElementIds: {
            ...prevState.selectedElementIds,
            [multiElement.id]: true,
          },
        }));
        multiElement.points.push([x - rx, y - ry]);
        invalidateShapeForElement(multiElement);
      } else {
        this.setState(prevState => ({
          selectedElementIds: {
            ...prevState.selectedElementIds,
            [element.id]: false,
          },
        }));
        element.points.push([0, 0]);
        invalidateShapeForElement(element);
        elements = [...elements, element];
        this.setState({
          draggingElement: element,
        });
      }
    } else if (element.type === "selection") {
      this.setState({
        selectionElement: element,
        draggingElement: element,
      });
    } else {
      elements = [...elements, element];
      this.setState({ multiElement: null, draggingElement: element });
    }

    let resizeArrowFn:
      | ((
          element: ExcalidrawElement,
          p1: Point,
          deltaX: number,
          deltaY: number,
          pointerX: number,
          pointerY: number,
          perfect: boolean,
        ) => void)
      | null = null;

    const arrowResizeOrigin = (
      element: ExcalidrawElement,
      p1: Point,
      deltaX: number,
      deltaY: number,
      pointerX: number,
      pointerY: number,
      perfect: boolean,
    ) => {
      if (perfect) {
        const absPx = p1[0] + element.x;
        const absPy = p1[1] + element.y;

        const { width, height } = getPerfectElementSize(
          element.type,
          pointerX - element.x - p1[0],
          pointerY - element.y - p1[1],
        );

        const dx = element.x + width + p1[0];
        const dy = element.y + height + p1[1];
        element.x = dx;
        element.y = dy;
        p1[0] = absPx - element.x;
        p1[1] = absPy - element.y;
      } else {
        element.x += deltaX;
        element.y += deltaY;
        p1[0] -= deltaX;
        p1[1] -= deltaY;
      }
    };

    const arrowResizeEnd = (
      element: ExcalidrawElement,
      p1: Point,
      deltaX: number,
      deltaY: number,
      pointerX: number,
      pointerY: number,
      perfect: boolean,
    ) => {
      if (perfect) {
        const { width, height } = getPerfectElementSize(
          element.type,
          pointerX - element.x,
          pointerY - element.y,
        );
        p1[0] = width;
        p1[1] = height;
      } else {
        p1[0] += deltaX;
        p1[1] += deltaY;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (isOverHorizontalScrollBar) {
        const x = event.clientX;
        const dx = x - lastX;
        this.setState({
          scrollX: normalizeScroll(this.state.scrollX - dx / this.state.zoom),
        });
        lastX = x;
        return;
      }

      if (isOverVerticalScrollBar) {
        const y = event.clientY;
        const dy = y - lastY;
        this.setState({
          scrollY: normalizeScroll(this.state.scrollY - dy / this.state.zoom),
        });
        lastY = y;
        return;
      }

      // for arrows, don't start dragging until a given threshold
      //  to ensure we don't create a 2-point arrow by mistake when
      //  user clicks mouse in a way that it moves a tiny bit (thus
      //  triggering pointermove)
      if (
        !draggingOccurred &&
        (this.state.elementType === "arrow" ||
          this.state.elementType === "line")
      ) {
        const { x, y } = viewportCoordsToSceneCoords(
          event,
          this.state,
          this.canvas,
        );
        if (distance2d(x, y, originX, originY) < DRAGGING_THRESHOLD) {
          return;
        }
      }

      if (isResizingElements && this.state.resizingElement) {
        this.setState({ isResizing: true });
        const el = this.state.resizingElement;
        const selectedElements = getSelectedElements(elements, this.state);
        if (selectedElements.length === 1) {
          const { x, y } = viewportCoordsToSceneCoords(
            event,
            this.state,
            this.canvas,
          );
          const deltaX = x - lastX;
          const deltaY = y - lastY;
          const element = selectedElements[0];
          const isLinear = element.type === "line" || element.type === "arrow";
          switch (resizeHandle) {
            case "nw":
              if (isLinear && element.points.length === 2) {
                const [, p1] = element.points;

                if (!resizeArrowFn) {
                  if (p1[0] < 0 || p1[1] < 0) {
                    resizeArrowFn = arrowResizeEnd;
                  } else {
                    resizeArrowFn = arrowResizeOrigin;
                  }
                }
                resizeArrowFn(
                  element,
                  p1,
                  deltaX,
                  deltaY,
                  x,
                  y,
                  event.shiftKey,
                );
              } else {
                element.width -= deltaX;
                element.x += deltaX;

                if (event.shiftKey) {
                  element.y += element.height - element.width;
                  element.height = element.width;
                } else {
                  element.height -= deltaY;
                  element.y += deltaY;
                }
              }
              break;
            case "ne":
              if (isLinear && element.points.length === 2) {
                const [, p1] = element.points;
                if (!resizeArrowFn) {
                  if (p1[0] >= 0) {
                    resizeArrowFn = arrowResizeEnd;
                  } else {
                    resizeArrowFn = arrowResizeOrigin;
                  }
                }
                resizeArrowFn(
                  element,
                  p1,
                  deltaX,
                  deltaY,
                  x,
                  y,
                  event.shiftKey,
                );
              } else {
                element.width += deltaX;
                if (event.shiftKey) {
                  element.y += element.height - element.width;
                  element.height = element.width;
                } else {
                  element.height -= deltaY;
                  element.y += deltaY;
                }
              }
              break;
            case "sw":
              if (isLinear && element.points.length === 2) {
                const [, p1] = element.points;
                if (!resizeArrowFn) {
                  if (p1[0] <= 0) {
                    resizeArrowFn = arrowResizeEnd;
                  } else {
                    resizeArrowFn = arrowResizeOrigin;
                  }
                }
                resizeArrowFn(
                  element,
                  p1,
                  deltaX,
                  deltaY,
                  x,
                  y,
                  event.shiftKey,
                );
              } else {
                element.width -= deltaX;
                element.x += deltaX;
                if (event.shiftKey) {
                  element.height = element.width;
                } else {
                  element.height += deltaY;
                }
              }
              break;
            case "se":
              if (isLinear && element.points.length === 2) {
                const [, p1] = element.points;
                if (!resizeArrowFn) {
                  if (p1[0] > 0 || p1[1] > 0) {
                    resizeArrowFn = arrowResizeEnd;
                  } else {
                    resizeArrowFn = arrowResizeOrigin;
                  }
                }
                resizeArrowFn(
                  element,
                  p1,
                  deltaX,
                  deltaY,
                  x,
                  y,
                  event.shiftKey,
                );
              } else {
                if (event.shiftKey) {
                  element.width += deltaX;
                  element.height = element.width;
                } else {
                  element.width += deltaX;
                  element.height += deltaY;
                }
              }
              break;
            case "n": {
              element.height -= deltaY;
              element.y += deltaY;

              if (element.points.length > 0) {
                const len = element.points.length;

                const points = [...element.points].sort((a, b) => a[1] - b[1]);

                for (let i = 1; i < points.length; ++i) {
                  const pnt = points[i];
                  pnt[1] -= deltaY / (len - i);
                }
              }
              break;
            }
            case "w": {
              element.width -= deltaX;
              element.x += deltaX;

              if (element.points.length > 0) {
                const len = element.points.length;
                const points = [...element.points].sort((a, b) => a[0] - b[0]);

                for (let i = 0; i < points.length; ++i) {
                  const pnt = points[i];
                  pnt[0] -= deltaX / (len - i);
                }
              }
              break;
            }
            case "s": {
              element.height += deltaY;
              if (element.points.length > 0) {
                const len = element.points.length;
                const points = [...element.points].sort((a, b) => a[1] - b[1]);

                for (let i = 1; i < points.length; ++i) {
                  const pnt = points[i];
                  pnt[1] += deltaY / (len - i);
                }
              }
              break;
            }
            case "e": {
              element.width += deltaX;
              if (element.points.length > 0) {
                const len = element.points.length;
                const points = [...element.points].sort((a, b) => a[0] - b[0]);

                for (let i = 1; i < points.length; ++i) {
                  const pnt = points[i];
                  pnt[0] += deltaX / (len - i);
                }
              }
              break;
            }
          }

          if (resizeHandle) {
            resizeHandle = normalizeResizeHandle(element, resizeHandle);
          }
          normalizeDimensions(element);

          document.documentElement.style.cursor = getCursorForResizingElement({
            element,
            resizeHandle,
          });
          el.x = element.x;
          el.y = element.y;
          invalidateShapeForElement(el);

          lastX = x;
          lastY = y;
          this.setState({});
          return;
        }
      }

      if (hitElement && this.state.selectedElementIds[hitElement.id]) {
        // Marking that click was used for dragging to check
        // if elements should be deselected on pointerup
        draggingOccurred = true;
        const selectedElements = getSelectedElements(elements, this.state);
        if (selectedElements.length > 0) {
          const { x, y } = viewportCoordsToSceneCoords(
            event,
            this.state,
            this.canvas,
          );

          selectedElements.forEach(element => {
            element.x += x - lastX;
            element.y += y - lastY;
          });
          lastX = x;
          lastY = y;
          this.setState({});
          return;
        }
      }

      // It is very important to read this.state within each move event,
      // otherwise we would read a stale one!
      const draggingElement = this.state.draggingElement;
      if (!draggingElement) {
        return;
      }

      const { x, y } = viewportCoordsToSceneCoords(
        event,
        this.state,
        this.canvas,
      );

      let width = distance(originX, x);
      let height = distance(originY, y);

      const isLinear =
        this.state.elementType === "line" || this.state.elementType === "arrow";

      if (isLinear) {
        draggingOccurred = true;
        const points = draggingElement.points;
        let dx = x - draggingElement.x;
        let dy = y - draggingElement.y;

        if (event.shiftKey && points.length === 2) {
          ({ width: dx, height: dy } = getPerfectElementSize(
            this.state.elementType,
            dx,
            dy,
          ));
        }

        if (points.length === 1) {
          points.push([dx, dy]);
        } else if (points.length > 1) {
          const pnt = points[points.length - 1];
          pnt[0] = dx;
          pnt[1] = dy;
        }
      } else {
        if (event.shiftKey) {
          ({ width, height } = getPerfectElementSize(
            this.state.elementType,
            width,
            y < originY ? -height : height,
          ));

          if (height < 0) {
            height = -height;
          }
        }

        draggingElement.x = x < originX ? originX - width : originX;
        draggingElement.y = y < originY ? originY - height : originY;

        draggingElement.width = width;
        draggingElement.height = height;
      }

      invalidateShapeForElement(draggingElement);

      if (this.state.elementType === "selection") {
        if (!event.shiftKey && isSomeElementSelected(elements, this.state)) {
          this.setState({ selectedElementIds: {} });
        }
        const elementsWithinSelection = getElementsWithinSelection(
          elements,
          draggingElement,
        );
        this.setState(prevState => ({
          selectedElementIds: {
            ...prevState.selectedElementIds,
            ...Object.fromEntries(
              elementsWithinSelection.map(element => [element.id, true]),
            ),
          },
        }));
      }
      this.setState({});
    };

    const onPointerUp = (event: PointerEvent) => {
      const {
        draggingElement,
        resizingElement,
        multiElement,
        elementType,
        elementLocked,
      } = this.state;

      this.setState({
        isResizing: false,
        resizingElement: null,
        selectionElement: null,
      });

      resizeArrowFn = null;
      lastPointerUp = null;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);

      if (elementType === "arrow" || elementType === "line") {
        if (draggingElement!.points.length > 1) {
          history.resumeRecording();
          this.setState({});
        }
        if (!draggingOccurred && draggingElement && !multiElement) {
          const { x, y } = viewportCoordsToSceneCoords(
            event,
            this.state,
            this.canvas,
          );
          draggingElement.points.push([
            x - draggingElement.x,
            y - draggingElement.y,
          ]);
          invalidateShapeForElement(draggingElement);
          this.setState({ multiElement: this.state.draggingElement });
        } else if (draggingOccurred && !multiElement) {
          if (!elementLocked) {
            resetCursor();
            this.setState(prevState => ({
              draggingElement: null,
              elementType: "selection",
              selectedElementIds: {
                ...prevState.selectedElementIds,
                [this.state.draggingElement!.id]: true,
              },
            }));
          } else {
            this.setState(prevState => ({
              draggingElement: null,
              selectedElementIds: {
                ...prevState.selectedElementIds,
                [this.state.draggingElement!.id]: true,
              },
            }));
          }
        }
        return;
      }

      if (
        elementType !== "selection" &&
        draggingElement &&
        isInvisiblySmallElement(draggingElement)
      ) {
        // remove invisible element which was added in onPointerDown
        elements = elements.slice(0, -1);
        this.setState({
          draggingElement: null,
        });
        return;
      }

      if (normalizeDimensions(draggingElement)) {
        this.setState({});
      }

      if (resizingElement) {
        history.resumeRecording();
        this.setState({});
      }

      if (resizingElement && isInvisiblySmallElement(resizingElement)) {
        elements = elements.filter(el => el.id !== resizingElement.id);
      }

      // If click occurred on already selected element
      // it is needed to remove selection from other elements
      // or if SHIFT or META key pressed remove selection
      // from hitted element
      //
      // If click occurred and elements were dragged or some element
      // was added to selection (on pointerdown phase) we need to keep
      // selection unchanged
      if (hitElement && !draggingOccurred && !elementIsAddedToSelection) {
        if (event.shiftKey) {
          this.setState(prevState => ({
            selectedElementIds: {
              ...prevState.selectedElementIds,
              [hitElement!.id]: false,
            },
          }));
        } else {
          this.setState(prevState => ({
            selectedElementIds: { [hitElement!.id]: true },
          }));
        }
      }

      if (draggingElement === null) {
        // if no element is clicked, clear the selection and redraw
        this.setState({ selectedElementIds: {} });
        return;
      }

      if (!elementLocked) {
        this.setState(prevState => ({
          selectedElementIds: {
            ...prevState.selectedElementIds,
            [draggingElement.id]: true,
          },
        }));
      }

      if (
        elementType !== "selection" ||
        isSomeElementSelected(elements, this.state)
      ) {
        history.resumeRecording();
      }

      if (!elementLocked) {
        resetCursor();
        this.setState({
          draggingElement: null,
          elementType: "selection",
        });
      } else {
        this.setState({
          draggingElement: null,
        });
      }
    };

    lastPointerUp = onPointerUp;

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  private handleWheel = (event: WheelEvent) => {
    event.preventDefault();
    const { deltaX, deltaY } = event;

    if (event[KEYS.CTRL_OR_CMD]) {
      const sign = Math.sign(deltaY);
      const MAX_STEP = 10;
      let delta = Math.abs(deltaY);
      if (delta > MAX_STEP) {
        delta = MAX_STEP;
      }
      delta *= sign;
      this.setState(({ zoom }) => ({
        zoom: getNormalizedZoom(zoom - delta / 100),
      }));
      return;
    }

    this.setState(({ zoom, scrollX, scrollY }) => ({
      scrollX: normalizeScroll(scrollX - deltaX / zoom),
      scrollY: normalizeScroll(scrollY - deltaY / zoom),
    }));
  };

  private addElementsFromPaste = (
    clipboardElements: readonly ExcalidrawElement[],
  ) => {
    const [minX, minY, maxX, maxY] = getCommonBounds(clipboardElements);

    const elementsCenterX = distance(minX, maxX) / 2;
    const elementsCenterY = distance(minY, maxY) / 2;

    const { x, y } = viewportCoordsToSceneCoords(
      { clientX: cursorX, clientY: cursorY },
      this.state,
      this.canvas,
    );

    const dx = x - elementsCenterX;
    const dy = y - elementsCenterY;

    const newElements = clipboardElements.map(clipboardElements => {
      const duplicate = duplicateElement(clipboardElements);
      duplicate.x += dx - minX;
      duplicate.y += dy - minY;
      return duplicate;
    });

    elements = [...elements, ...newElements];
    history.resumeRecording();
    this.setState({
      selectedElementIds: Object.fromEntries(
        newElements.map(element => [element.id, true]),
      ),
    });
  };

  private getTextWysiwygSnappedToCenterPosition(x: number, y: number) {
    const elementClickedInside = getElementContainingPosition(elements, x, y);
    if (elementClickedInside) {
      const elementCenterX =
        elementClickedInside.x + elementClickedInside.width / 2;
      const elementCenterY =
        elementClickedInside.y + elementClickedInside.height / 2;
      const distanceToCenter = Math.hypot(
        x - elementCenterX,
        y - elementCenterY,
      );
      const isSnappedToCenter =
        distanceToCenter < TEXT_TO_CENTER_SNAP_THRESHOLD;
      if (isSnappedToCenter) {
        const wysiwygX =
          this.state.scrollX +
          elementClickedInside.x +
          elementClickedInside.width / 2;
        const wysiwygY =
          this.state.scrollY +
          elementClickedInside.y +
          elementClickedInside.height / 2;
        return { wysiwygX, wysiwygY, elementCenterX, elementCenterY };
      }
    }
  }

  private saveDebounced = debounce(() => {
    saveToLocalStorage(elements, this.state);
  }, 300);

  componentDidUpdate() {
    const { atLeastOneVisibleElement, scrollBars } = renderScene(
      elements,
      this.state,
      this.state.selectionElement,
      this.rc!,
      this.canvas!,
      {
        scrollX: this.state.scrollX,
        scrollY: this.state.scrollY,
        viewBackgroundColor: this.state.viewBackgroundColor,
        zoom: this.state.zoom,
      },
      {
        renderOptimizations: true,
      },
    );
    if (scrollBars) {
      currentScrollBars = scrollBars;
    }
    const scrolledOutside = !atLeastOneVisibleElement && elements.length > 0;
    if (this.state.scrolledOutside !== scrolledOutside) {
      this.setState({ scrolledOutside: scrolledOutside });
    }
    this.saveDebounced();
    if (history.isRecording()) {
      history.pushEntry(this.state, elements);
      history.skipRecording();
    }
  }
}
