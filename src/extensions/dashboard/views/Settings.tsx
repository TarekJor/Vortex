import Toggle from '../../../controls/Toggle';
import { IDashletSettings, IState } from '../../../types/IState';
import { ComponentEx, connect, translate } from '../../../util/ComponentEx';

import { setDashletEnabled } from '../actions';
import { IDashletProps } from '../types/IDashletProps';

import * as React from 'react';
import { ControlLabel, FormGroup, HelpBlock } from 'react-bootstrap';
import * as Redux from 'redux';
import { getSafe } from '../../../util/storeHelper';

interface IDashletToggleProps {
  enabled: boolean;
  dashlet: IDashletProps;
  onToggle: (dashletId: string, enabled: boolean) => void;
}

class DashletToggle extends React.PureComponent<IDashletToggleProps, {}> {
  public render(): JSX.Element {
    const { dashlet, enabled } = this.props;
    return (
      <Toggle checked={enabled} onToggle={this.toggle}>
        {dashlet.title}
      </Toggle>
    );
  }

  private toggle = (newValue: boolean) => {
    const { dashlet, onToggle } = this.props;
    onToggle(dashlet.title, newValue);
  }
}

export interface IBaseProps {
  dashlets: IDashletProps[];
}

interface IActionProps {
  onSetDashletEnabled: (dashletId: string, enabled: boolean) => void;
}

interface IConnectedProps {
  dashletSettings: { [dashletId: string]: IDashletSettings };
}

type IProps = IBaseProps & IActionProps & IConnectedProps;

class Settings extends ComponentEx<IProps, {}> {
  public render(): JSX.Element {
    const { t, dashlets, dashletSettings, onSetDashletEnabled } = this.props;

    return (
      <form>
        <FormGroup controlId='dashlets'>
          <ControlLabel>{t('Dashlets')}</ControlLabel>
          <HelpBlock>{t('Choose which widgets to show')}</HelpBlock>
          {
            dashlets.filter(dashlet => dashlet.closable !== false).map(dashlet => (
              <DashletToggle
                key={dashlet.title}
                dashlet={dashlet}
                enabled={getSafe(dashletSettings, [dashlet.title, 'enabled'], true)}
                onToggle={onSetDashletEnabled}
              />
            ))
          }
        </FormGroup>
      </form>
    );
  }
}

function mapStateToProps(state: IState): IConnectedProps {
  return {
    dashletSettings: state.settings.interface.dashletSettings,
  };
}

function mapDispatchToProps(dispatch: Redux.Dispatch<any>): IActionProps {
  return {
    onSetDashletEnabled: (dashletId: string, enabled: boolean) =>
      dispatch(setDashletEnabled(dashletId, enabled)),
  };
}

export default
  translate(['common'])(
    connect(mapStateToProps, mapDispatchToProps)(
      Settings)) as React.ComponentClass<{}>;
