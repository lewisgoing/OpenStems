import { BrowserWindow, Menu, Notification, Tray, screen } from 'electron'
import { log } from './log'
import {
  POPUP_SIZE,
  type Rect,
  type TrayActivity,
  type TrayPresentation,
  menuBarPlacement,
  popupChrome,
  popupPlacement,
  readyNotice,
  trayClickAction,
  trayIconFile,
  trayMenuTemplate,
  trayPresentation,
} from './traylogic'
import { background, iconPath, loadRenderer, webPreferences } from './windows'

const MAC = process.platform === 'darwin'

interface TrayHost {
  openMain: () => void
  quit: () => void
  /** The full window has the user's attention, so a finished job counts as seen. */
  mainFocused: () => boolean
  /** The user wants to be told when songs finish out of sight. */
  notifyReady: () => boolean
  /** In tests, record the notice instead of raising a real notification. */
  recordNotice?: (title: string) => void
}

/**
 * The tray icon (on a Mac, the menu bar item) and the quick-drop window it opens.
 *
 * The window stays open when it loses focus: a drop always starts in another window (Explorer
 * or Finder, a DAW's browser), so a window that hid on blur could never be dropped on. It
 * goes away when the icon is clicked again, on Escape, with its close button, or when the
 * full app is opened.
 */
export class TrayController {
  tray: Tray | null = null
  popup: BrowserWindow | null = null
  presentation: TrayPresentation = trayPresentation(null, null)
  private popupLoaded = false
  private showWhenLoaded = false
  private closing = false
  private activity: TrayActivity | null = null
  private seenDone: string | null = null
  /** Songs that finished since the user last looked. */
  private unseen = 0
  /** The Mac notification on screen, held so it is still there to be clicked. */
  private notice: Notification | null = null

  constructor(private readonly host: TrayHost) {}

  /** Put the icon in the notification area or the menu bar. A machine without one still runs the app. */
  create(): void {
    try {
      const tray = new Tray(iconPath(trayIconFile('idle', process.platform)))
      tray.setToolTip(this.presentation.tooltip)
      const menu = Menu.buildFromTemplate(
        trayMenuTemplate(process.platform, {
          quickDrop: () => this.show(),
          openMain: () => this.host.openMain(),
          quit: () => this.host.quit(),
        }),
      )
      // What each press does is decided in `trayClickAction`.
      const press = (kind: 'click' | 'right-click' | 'double-click', ctrlKey = false) => {
        const action = trayClickAction(process.platform, kind, ctrlKey)
        if (action === 'toggle') this.toggle()
        else if (action === 'main') this.host.openMain()
        else if (action === 'menu') tray.popUpContextMenu(menu)
      }
      if (MAC) {
        // A menu set on a menu bar item opens on every click. Here a click belongs to the
        // quick-drop window, and the menu comes up on a right click or a Control click.
        tray.on('click', (event) => press('click', event?.ctrlKey === true))
        tray.on('right-click', () => press('right-click'))
        // No double click on a Mac: waiting for a second click would hold back the first.
        tray.setIgnoreDoubleClickEvents(true)
      } else {
        tray.setContextMenu(menu)
        // Windows reports the press, then `double-click` in place of a second press: one click
        // toggles the quick-drop window and a double click ends in the full app.
        tray.on('click', () => press('click'))
        tray.on('double-click', () => press('double-click'))
        tray.on('balloon-click', () => this.show())
      }
      this.tray = tray
    } catch (error) {
      log(`no tray icon: ${String(error)}`)
    }
  }

  /** Build the quick-drop window ahead of the first click, so that click shows it at once. */
  prewarm(): BrowserWindow {
    if (this.popup && !this.popup.isDestroyed()) return this.popup
    const popup = new BrowserWindow({
      ...POPUP_SIZE,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      ...popupChrome(process.platform),
      backgroundColor: background(),
      title: 'OpenStems quick drop',
      icon: iconPath('icon.png'),
      webPreferences: webPreferences(),
    })
    this.popup = popup
    this.popupLoaded = false
    popup.once('ready-to-show', () => {
      this.popupLoaded = true
      if (this.showWhenLoaded) this.place()
    })
    // Alt+F4, or Cmd+W on a Mac, hides it; only quitting the app closes it.
    popup.on('close', (event) => {
      if (this.closing) return
      event.preventDefault()
      this.hide()
    })
    popup.on('closed', () => {
      if (this.popup === popup) this.popup = null
    })
    loadRenderer(popup, 'tray')
    return popup
  }

  /** Jobs queued or running, as the quick-drop window last reported them. */
  get activeJobs(): number {
    return this.activity?.active ?? 0
  }

  get visible(): boolean {
    return Boolean(this.popup && !this.popup.isDestroyed() && this.popup.isVisible())
  }

  toggle(): void {
    if (this.visible) this.hide()
    else this.show()
  }

  show(): void {
    this.prewarm()
    if (this.popupLoaded) this.place()
    else this.showWhenLoaded = true
  }

  /** `returnFocus` hands the keyboard back to the notification area, as Windows asks after Escape. */
  hide(returnFocus = false): void {
    this.showWhenLoaded = false
    if (!this.visible) return
    this.popup?.hide()
    // A Mac has no such thing: the keyboard goes back to the app that had it.
    if (returnFocus && !MAC) this.tray?.focus()
  }

  private iconBounds(): Rect | null {
    try {
      const bounds = this.tray?.getBounds()
      return bounds && bounds.width > 0 && bounds.height > 0 ? bounds : null
    } catch {
      return null
    }
  }

  private place(): void {
    const popup = this.popup
    if (!popup || popup.isDestroyed()) return
    this.showWhenLoaded = false
    const icon = this.iconBounds()
    const display = icon ? screen.getDisplayMatching(icon) : screen.getPrimaryDisplay()
    const area = { bounds: display.bounds, workArea: display.workArea }
    const spot = MAC ? menuBarPlacement(icon, area) : popupPlacement(icon, area)
    const [width, height] = popup.getSize()
    // Resize only on a screen too small for the usual size; otherwise just move.
    if (width !== spot.width || height !== spot.height) {
      popup.setBounds({ x: spot.x, y: spot.y, width: spot.width, height: spot.height })
    } else {
      popup.setPosition(spot.x, spot.y)
    }
    popup.show()
    popup.focus()
    this.markSeen()
  }

  /** The quick-drop window reports the queue; the icon and tooltip follow. */
  setActivity(activity: TrayActivity): void {
    const before = this.activity?.done?.id
    this.activity = activity
    const done = activity.done?.id
    if (this.visible || this.host.mainFocused()) {
      this.seenDone = done ?? this.seenDone
      this.unseen = 0
    } else if (done && done !== before) {
      this.unseen += 1
    }
    this.render()
  }

  /** The user is looking at the results: the "stems are ready" mark has done its job. */
  markSeen(): void {
    this.unseen = 0
    const done = this.activity?.done?.id
    if (!done || done === this.seenDone) return
    this.seenDone = done
    this.render()
  }

  private render(): void {
    const next = trayPresentation(this.activity, this.seenDone)
    const previous = this.presentation
    this.presentation = next
    if (!this.tray || this.tray.isDestroyed()) {
      if (next.icon === 'ready' && previous.icon !== 'ready') this.notifyReady()
      return
    }
    if (next.icon !== previous.icon) this.tray.setImage(iconPath(trayIconFile(next.icon, process.platform)))
    if (next.tooltip !== previous.tooltip) this.tray.setToolTip(next.tooltip)
    // Said once, when the queue has run dry out of sight: not once per song.
    if (next.icon === 'ready' && previous.icon !== 'ready') this.notifyReady()
  }

  private notifyReady(): void {
    const done = this.activity?.done
    if (!done || !this.host.notifyReady()) return
    this.raise(readyNotice(done, this.unseen))
  }

  /**
   * Said once, the first time closing the window leaves the app in the tray. Windows only:
   * on a Mac an app that outlives its window is the usual thing and needs no notice.
   */
  notifyStillRunning(): void {
    this.raise({
      title: 'OpenStems is still running',
      content: 'Click its icon here to drop a song. Right-click the icon to quit.',
    })
  }

  /** A click on the notice opens the quick-drop window. */
  private raise(notice: { title: string; content: string }): void {
    if (this.host.recordNotice) {
      this.host.recordNotice(notice.title)
      return
    }
    if (!MAC) {
      this.tray?.displayBalloon({ iconType: 'custom', icon: iconPath('icon.png'), ...notice, respectQuietTime: true })
      return
    }
    // A Mac has no balloons. Its notifications follow the user's Focus by themselves.
    // macOS delivers them only for an app with a valid signature. An ad hoc one should be
    // enough (`mac-build.cjs`); a bundle without one hears `failed`, or nothing at all.
    if (!Notification.isSupported()) return
    const shown = new Notification({ title: notice.title, body: notice.content })
    const release = () => {
      if (this.notice === shown) this.notice = null
    }
    shown.on('click', () => {
      release()
      this.show()
    })
    shown.on('close', release)
    shown.on('failed', (_event, error) => {
      log(`the notification was not delivered: ${error}`)
      release()
    })
    this.notice = shown
    shown.show()
  }

  destroy(): void {
    this.closing = true
    this.notice = null
    if (this.popup && !this.popup.isDestroyed()) this.popup.destroy()
    this.popup = null
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy()
    this.tray = null
  }
}
