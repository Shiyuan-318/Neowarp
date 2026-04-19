import React from 'react';
import {connect} from 'react-redux';
import PropTypes from 'prop-types';
import {
  openLoadingProject,
  closeLoadingProject,
  openInvalidProjectModal
} from 'scratch-gui/src/reducers/modals';
import {
  requestProjectUpload,
  setProjectId,
  defaultProjectId,
  onFetchedProjectData,
  onLoadedProject,
  requestNewProject
} from 'scratch-gui/src/reducers/project-state';
import {
  setFileHandle,
  setUsername,
  setProjectError
} from 'scratch-gui/src/reducers/tw';
import {WrappedFileHandle} from './filesystem-api.js';
import {setStrings} from '../prompt/prompt.js';

let mountedOnce = false;
let isStageDetached = false;
let frameStreamingActive = false;
let frameAnimationId = null;

/**
 * @param {string} filename
 * @returns {string}
 */
const getDefaultProjectTitle = (filename) => {
  const match = filename.match(/([^/\\]+)\.sb[2|3]?$/);
  if (!match) return filename;
  return match[1];
};

const handleClickAddonSettings = (search) => {
  EditorPreload.openAddonSettings(typeof search === 'string' ? search : null);
};

const handleClickNewWindow = () => {
  EditorPreload.openNewWindow();
};

const handleClickPackager = () => {
  EditorPreload.openPackager();
};

const handleClickDesktopSettings = () => {
  EditorPreload.openDesktopSettings();
};

const handleClickPrivacy = () => {
  EditorPreload.openPrivacy();
};

const handleClickAbout = () => {
  EditorPreload.openAbout();
};

const handleClickSourceCode = () => {
  window.open('https://github.com/TurboWarp');
};

const startFrameStreaming = (vm) => {
  if (frameStreamingActive) return;
  frameStreamingActive = true;

  const streamFrame = () => {
    if (!frameStreamingActive || !isStageDetached) return;
    try {
      if (vm.renderer && vm.renderer.requestSnapshot) {
        // Use the renderer's built-in snapshot API
        // This properly handles preserveDrawingBuffer and renders the frame
        vm.renderer.requestSnapshot((dataURL) => {
          if (frameStreamingActive && isStageDetached) {
            EditorPreload.sendStageFrame(dataURL);
          }
        });
      }
    } catch (e) {
      // ignore
    }
    frameAnimationId = setTimeout(streamFrame, 33);
  };
  streamFrame();
};

const stopFrameStreaming = () => {
  frameStreamingActive = false;
  if (frameAnimationId !== null) {
    clearTimeout(frameAnimationId);
    frameAnimationId = null;
  }
};

const handleDetachedStageInput = (vm, inputData) => {
  try {
    if (inputData.type === 'mousedown' || inputData.type === 'mouseup' || inputData.type === 'mousemove') {
      const data = {
        x: inputData.x,
        y: inputData.y,
        canvasWidth: inputData.canvasWidth || 480,
        canvasHeight: inputData.canvasHeight || 360
      };
      if (inputData.type === 'mousedown') {
        data.isDown = true;
        data.button = inputData.button || 0;
      } else if (inputData.type === 'mouseup') {
        data.isDown = false;
        data.button = inputData.button || 0;
      }
      vm.postIOData('mouse', data);
    } else if (inputData.type === 'wheel') {
      vm.postIOData('mouseWheel', {
        deltaX: inputData.deltaX,
        deltaY: inputData.deltaY
      });
    } else if (inputData.type === 'keydown') {
      vm.postIOData('keyboard', {
        key: inputData.key,
        code: inputData.code,
        isDown: true
      });
    } else if (inputData.type === 'keyup') {
      vm.postIOData('keyboard', {
        key: inputData.key,
        code: inputData.code,
        isDown: false
      });
    }
  } catch (e) {
    // ignore
  }
};

const securityManager = {
  // Everything not specified here falls back to the scratch-gui security manager

  // Managed by Electron main process:
  canReadClipboard: () => true,
  canNotify: () => true,

  // Does not work in Electron:
  canGeolocate: () => false
};

const USERNAME_KEY = 'tw:username';
const DEFAULT_USERNAME = 'player';

const DesktopHOC = function (WrappedComponent) {
  class DesktopComponent extends React.Component {
    constructor (props) {
      super(props);
      this.state = {
        title: ''
      };
      this.handleUpdateProjectTitle = this.handleUpdateProjectTitle.bind(this);

      // Changing locale always re-mounts this component
      const stateFromMain = EditorPreload.setLocale(this.props.locale);
      this.messages = stateFromMain.strings;
      setStrings({
        ok: this.messages['prompt.ok'],
        cancel: this.messages['prompt.cancel']
      });

      const storedUsername = localStorage.getItem(USERNAME_KEY);
      if (typeof storedUsername === 'string') {
        this.props.onSetReduxUsername(storedUsername);
      } else {
        this.props.onSetReduxUsername(DEFAULT_USERNAME);
      }
    }
    componentDidMount () {
      EditorPreload.setExportForPackager(() => this.props.vm.saveProjectSb3('arraybuffer')
        .then((buffer) => ({
          name: this.state.title,
          data: buffer
        })));

      EditorPreload.onStageDetached(() => {
        isStageDetached = true;
        startFrameStreaming(this.props.vm);
      });

      EditorPreload.onStageReattached(() => {
        isStageDetached = false;
        stopFrameStreaming();
      });

      EditorPreload.onDetachedStageInput((inputData) => {
        handleDetachedStageInput(this.props.vm, inputData);
      });

      // Apply code area background image
      const backgroundImage = EditorPreload.getCodeAreaBackgroundImage();
      if (backgroundImage) {
        this.applyCodeAreaBackground(backgroundImage);
      }

      // Listen for settings changes
      window.addEventListener('focus', () => {
        const newBackgroundImage = EditorPreload.getCodeAreaBackgroundImage();
        this.applyCodeAreaBackground(newBackgroundImage);
      });

      // This component is re-mounted when the locale changes, but we only want to load
      // the initial project once.
      if (mountedOnce) {
        return;
      }
      mountedOnce = true;

      this.props.onLoadingStarted();
      (async () => {
        // Note that 0 is a valid ID and does mean there is a file open
        const id = await EditorPreload.getInitialFile();
        if (id === null) {
          this.props.onHasInitialProject(false, this.props.loadingState);
          this.props.onLoadingCompleted();
          return;
        }

        this.props.onHasInitialProject(true, this.props.loadingState);
        const {name, type, data} = await EditorPreload.getFile(id);

        await this.props.vm.loadProject(data);
        this.props.onLoadingCompleted();
        this.props.onLoadedProject(this.props.loadingState, true);

        const title = getDefaultProjectTitle(name);
        if (title) {
          this.setState({
            title
          });
        }

        if (type === 'file' && name.endsWith('.sb3')) {
          this.props.onSetFileHandle(new WrappedFileHandle(id, name));
        }
      })().catch(error => {
        console.error(error);

        this.props.onShowErrorModal(error);
        this.props.onLoadingCompleted();
        this.props.onLoadedProject(this.props.loadingState, false);
        this.props.onHasInitialProject(false, this.props.loadingState);
        this.props.onRequestNewProject();
      });
    }
    componentDidUpdate (prevProps, prevState) {
      if (this.props.projectChanged !== prevProps.projectChanged) {
        EditorPreload.setChanged(this.props.projectChanged);
      }

      if (this.state.title !== prevState.title) {
        document.title = this.state.title;
      }

      if (this.props.fileHandle !== prevProps.fileHandle) {
        if (this.props.fileHandle) {
          EditorPreload.openedFile(this.props.fileHandle.id);
        } else {
          EditorPreload.closedFile();
        }
      }

      if (this.props.reduxUsername !== prevProps.reduxUsername) {
        localStorage.setItem(USERNAME_KEY, this.props.reduxUsername);
      }

      if (this.props.isFullScreen !== prevProps.isFullScreen) {
        EditorPreload.setIsFullScreen(this.props.isFullScreen);
      }
    }
    componentWillUnmount () {
      stopFrameStreaming();
      isStageDetached = false;
    }
    handleUpdateProjectTitle (newTitle) {
      this.setState({
        title: newTitle
      });
    }
    applyCodeAreaBackground (backgroundImage) {
      // Apply background to injectionDiv (behind the blocks workspace)
      // The glassmorphism effect is on blocklySvg via CSS backdrop-filter
      const applyBackground = () => {
        const injectionDiv = document.querySelector('.injectionDiv');
        if (injectionDiv) {
          if (backgroundImage) {
            // Set background image on the container behind the workspace
            injectionDiv.style.backgroundImage = `url(${backgroundImage})`;
            injectionDiv.style.backgroundSize = 'cover';
            injectionDiv.style.backgroundPosition = 'center';
            injectionDiv.style.backgroundRepeat = 'no-repeat';
            injectionDiv.style.backgroundColor = 'transparent';
          } else {
            // Clear background image - will fall back to CSS default
            injectionDiv.style.backgroundImage = '';
            injectionDiv.style.backgroundSize = '';
            injectionDiv.style.backgroundPosition = '';
            injectionDiv.style.backgroundRepeat = '';
            injectionDiv.style.backgroundColor = '';
          }
        }
      };
      
      // Try immediately and after a delay to ensure Blockly is loaded
      applyBackground();
      setTimeout(applyBackground, 500);
      setTimeout(applyBackground, 1500);
    }
    render() {
      const {
        locale,
        loadingState,
        projectChanged,
        fileHandle,
        reduxUsername,
        onFetchedInitialProjectData,
        onHasInitialProject,
        onLoadedProject,
        onLoadingCompleted,
        onLoadingStarted,
        onRequestNewProject,
        onSetFileHandle,
        onSetReduxUsername,
        onShowErrorModal,
        vm,
        ...props
      } = this.props;
      return (
        <WrappedComponent
          projectTitle={this.state.title}
          onUpdateProjectTitle={this.handleUpdateProjectTitle}
          onClickAddonSettings={handleClickAddonSettings}
          onClickNewWindow={handleClickNewWindow}
          onClickPackager={handleClickPackager}
          onClickAbout={[
            {
              title: this.messages['in-app-about.desktop-settings'],
              onClick: handleClickDesktopSettings
            },
            {
              title: this.messages['in-app-about.privacy'],
              onClick: handleClickPrivacy
            },
            {
              title: this.messages['in-app-about.about'],
              onClick: handleClickAbout
            },
            {
              title: this.messages['in-app-about.source-code'],
              onClick: handleClickSourceCode
            },
          ]}
          onClickDesktopSettings={handleClickDesktopSettings}
          securityManager={securityManager}
          {...props}
        />
      );
    }
  }

  DesktopComponent.propTypes = {
    locale: PropTypes.string.isRequired,
    loadingState: PropTypes.string.isRequired,
    projectChanged: PropTypes.bool.isRequired,
    fileHandle: PropTypes.shape({
      id: PropTypes.string.isRequired
    }),
    isFullScreen: PropTypes.bool.isRequired,
    reduxUsername: PropTypes.string.isRequired,
    onFetchedInitialProjectData: PropTypes.func.isRequired,
    onHasInitialProject: PropTypes.func.isRequired,
    onLoadedProject: PropTypes.func.isRequired,
    onLoadingCompleted: PropTypes.func.isRequired,
    onLoadingStarted: PropTypes.func.isRequired,
    onRequestNewProject: PropTypes.func.isRequired,
    onSetFileHandle: PropTypes.func.isRequired,
    onSetReduxUsername: PropTypes.func.isRequired,
    onShowErrorModal: PropTypes.func.isRequired,
    vm: PropTypes.shape({
      loadProject: PropTypes.func.isRequired
    }).isRequired
  };

  const mapStateToProps = state => ({
    locale: state.locales.locale,
    loadingState: state.scratchGui.projectState.loadingState,
    isFullScreen: state.scratchGui.mode.isFullScreen,
    projectChanged: state.scratchGui.projectChanged,
    fileHandle: state.scratchGui.tw.fileHandle,
    reduxUsername: state.scratchGui.tw.username,
    vm: state.scratchGui.vm
  });

  const mapDispatchToProps = dispatch => ({
    onLoadingStarted: () => dispatch(openLoadingProject()),
    onLoadingCompleted: () => dispatch(closeLoadingProject()),
    onHasInitialProject: (hasInitialProject, loadingState) => {
      if (hasInitialProject) {
        return dispatch(requestProjectUpload(loadingState));
      }
      return dispatch(setProjectId(defaultProjectId));
    },
    onFetchedInitialProjectData: (projectData, loadingState) => dispatch(onFetchedProjectData(projectData, loadingState)),
    onLoadedProject: (loadingState, loadSuccess) => {
      return dispatch(onLoadedProject(loadingState, /* canSave */ false, loadSuccess));
    },
    onRequestNewProject: () => dispatch(requestNewProject(false)),
    onSetFileHandle: fileHandle => dispatch(setFileHandle(fileHandle)),
    onSetReduxUsername: username => dispatch(setUsername(username)),
    onShowErrorModal: error => {
      dispatch(setProjectError(error));
      dispatch(openInvalidProjectModal());
    }
  });

  return connect(
    mapStateToProps,
    mapDispatchToProps
  )(DesktopComponent);
};

export default DesktopHOC;
