import { ComponentEx, connect, translate } from '../../../util/ComponentEx';
import { ButtonType } from '../../../views/IconBar';
import ToolbarIcon from '../../../views/ToolbarIcon';

import { setAddGameDialogVisible } from '../actions/session';

import * as React from 'react';

export interface IBaseProps {
  buttonType: ButtonType;
  toggleHidden: () => void;
  showHidden: boolean;
  t: I18next.TranslationFunction;
}

class ShowHiddenButton extends ComponentEx<IBaseProps, {}> {
  public render(): JSX.Element {
    const { t, buttonType, showHidden, toggleHidden } = this.props;

    return (
      <ToolbarIcon
        id='show-hidden-games'
        text={t('Show / Hide hidden games')}
        onClick={toggleHidden}
        icon={showHidden ? 'eye-slash' : 'eye'}
        buttonType={buttonType}
      />
    );
  }
}

export default
  translate(['common'], { wait: false })(
    connect()(
      ShowHiddenButton)) as React.ComponentClass<IBaseProps>;