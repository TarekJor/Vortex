import { IAttributeState } from '../../types/IAttributeState';
import { ITableAttribute } from '../../types/ITableAttribute';
import { SortDirection } from '../../types/SortDirection';
import getAttr from '../../util/getAttr';

import SortIndicator from '../SortIndicator';

import * as React from 'react';

export interface IHeaderProps {
  className: string;
  attribute: ITableAttribute;
  state: IAttributeState;
  onSetSortDirection: (id: string, dir: SortDirection) => void;
  t: Function;
}

class HeaderCell extends React.Component<IHeaderProps, {}> {
  public render(): JSX.Element {
    const { t, attribute, className } = this.props;
    return (
      <th className={className} key={attribute.id}>
        <div>{ t(attribute.name) }
        { attribute.isSortable ? this.renderIndicator() : null }
        </div>
      </th>
    );
  }

  private renderIndicator() {
    const { state } = this.props;

    const direction: SortDirection = getAttr(state, 'sortDirection', 'none') as SortDirection;

    return (
      <SortIndicator direction={ direction } onSetDirection={ this.setDirection }/>
    );
  }

  private setDirection = (dir: SortDirection) => {
    let { attribute, onSetSortDirection } = this.props;
    onSetSortDirection(attribute.id, dir);
  }
}

export default HeaderCell;