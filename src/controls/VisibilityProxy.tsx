import update = require('immutability-helper');
import * as _ from 'lodash';
import * as React from 'react';
import * as ReactDOM from 'react-dom';

interface IRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface IProps {
  container?: HTMLElement;
  placeholder: () => React.ReactNode;
  content: () => React.ReactNode;
  startVisible: boolean;
}

export interface IState {
  visible: boolean;
  visibleTime: number;
}

/**
 * proxy component that delays loading of a control until it comes into view
 *
 * @class VisibilityProxy
 * @extends {React.Component<IProps, IState>}
 */
class VisibilityProxy extends React.Component<any, IState> {
  // need to use maps because the keys aren't PODs
  private static sObservers: Map<Element, IntersectionObserver> = new Map();
  private static sInstances: Map<Element, (visible: boolean) => void> = new Map();

  private static getObserver(container: HTMLElement) {
    if (!VisibilityProxy.sObservers.has(container || null)) {
      VisibilityProxy.sObservers.set(container || null,
          new IntersectionObserver(VisibilityProxy.callback, {
        root: container,
        rootMargin: '240px 0px 240px 0px',
        threshold: [0.5],
      } as any));
    }
    return VisibilityProxy.sObservers.get(container);
  }

  private static callback(entries: IntersectionObserverEntry[], observer: IntersectionObserver) {
    entries.forEach(entry => {
      const cb = VisibilityProxy.sInstances.get(entry.target);
      if (cb !== undefined) {
        cb((entry as any).isIntersecting);
      }
    });
  }

  private static observe(container: HTMLElement,
                         target: HTMLElement,
                         cb: (visible: boolean) => void) {
    VisibilityProxy.sInstances.set(target, cb);
    VisibilityProxy.getObserver(container).observe(target);
  }

  private static unobserve(container: HTMLElement, target: HTMLElement) {
    VisibilityProxy.sInstances.delete(target);
    VisibilityProxy.getObserver(container).unobserve(target);
  }

  constructor(props: IProps) {
    super(props);
    this.state = {
      visible: props.startVisible,
      visibleTime: 0,
    };
  }

  public componentDidMount() {
    const node = ReactDOM.findDOMNode(this) as HTMLElement;
    VisibilityProxy.observe(this.props.container, node, (visible: boolean) => {
      const now = Date.now();
      // workaround: There is the situation where when an element becomes visible it
      //   changes the layout around it which in turn pushes the element somwhere where it
      //   _isn't_ visible anymore, triggering an endless loop of the element switching
      //   between visible and invisible. Hence we don't turn items invisible if it
      //   became visible less than a second ago. Since the observer is flank triggered
      //   this may cause items to be rendered even though they don't have to but this
      //   is a performance optimisation anyway, nothing breaks.
      if ((this.state.visible !== visible) &&
          (visible || (now - this.state.visibleTime) > 1000.0)) {
        this.setState({ visible, visibleTime: now });
      }
    });
  }

  public componentWillUnmount() {
    VisibilityProxy.unobserve(this.props.container, ReactDOM.findDOMNode(this) as HTMLElement);
  }

  public render(): JSX.Element {
    return (
      <div {..._.omit(this.props, ['container', 'placeholder', 'content', 'startVisible'])}>{
        (this.state.visible)
          ? this.props.content()
          : this.props.placeholder()
      }</div>
    );
  }
}

export default VisibilityProxy;
