// Test-only Windows UI Automation. Never operates a process without its creation identity.
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using Microsoft.Win32;
using System.Drawing;
using System.Drawing.Imaging;
using System.Security.AccessControl;
using System.Security.Principal;

class BrowserDesktopProbe {
  static bool protocolInputAttempted=false;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct PE {public uint size,usage,pid;public IntPtr heap;public uint module,threads,parent;public int priority;public uint flags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string exe;}
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32First(IntPtr snap,ref PE entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32Next(IntPtr snap,ref PE entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder path,ref uint size);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO {public uint size;public string reserved,desktop,title;public uint x,y,width,height,xChars,yChars,fill,flags;public ushort show,reservedSize;public IntPtr reservedData,input,output,error;}
  [StructLayout(LayoutKind.Sequential)] struct PROCESSINFO {public IntPtr process,thread;public uint pid,tid;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref STARTUPINFO startup,out PROCESSINFO process);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("user32.dll")] static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr w);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow cb, IntPtr arg);
  delegate bool EnumWindow(IntPtr w, IntPtr arg);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr w, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr w, StringBuilder b, int n);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr w, uint m, IntPtr a, IntPtr b);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr w);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr w,uint flags);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder value,uint size,out uint needed);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern uint GetDoubleClickTime();
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT {public ushort key,scan;public uint flags,time;public UIntPtr extra;}
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT {public int x,y;public uint data,flags,time;public UIntPtr extra;}
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION {[FieldOffset(0)]public KEYBDINPUT keyboard;[FieldOffset(0)]public MOUSEINPUT mouse;}
  [StructLayout(LayoutKind.Sequential)] struct INPUT {public uint type;public INPUTUNION value;}
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] inputs,int size);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)]struct RECT {public int left,top,right,bottom;}
  [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr w,out RECT rect);
  [DllImport("user32.dll")]static extern bool PrintWindow(IntPtr w,IntPtr dc,uint flags);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("wtsapi32.dll",SetLastError=true)] static extern bool WTSQuerySessionInformation(IntPtr server,int session,int info,out IntPtr value,out uint bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr value);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr w, StringBuilder b, int n);
  static string Title(IntPtr w) { var b=new StringBuilder(1024); GetWindowText(w,b,b.Capacity); return b.ToString(); }
  static List<IntPtr> Windows(int pid) {
    var result=new List<IntPtr>(); EnumWindows((w,a)=>{uint p;GetWindowThreadProcessId(w,out p);if(p==pid)result.Add(w);return true;},IntPtr.Zero);return result;
  }
  static Process Owned(string[] a) {
    var p=Process.GetProcessById(Int32.Parse(a[1]));
    if(p.StartTime.ToUniversalTime().Ticks.ToString()!=a[2])throw new Exception("Process identity changed");return p;
  }
  static string ProcessImage(Process p) {
    var handle=OpenProcess(0x1000,false,p.Id);if(handle==IntPtr.Zero)return null;
    try{var path=new StringBuilder(32768);uint size=(uint)path.Capacity;return QueryFullProcessImageName(handle,0,path,ref size)?path.ToString():null;}
    finally{CloseHandle(handle);}
  }
  static object Info(Process p, IntPtr w,string image=null) {
    image=image??ProcessImage(p);if(String.IsNullOrEmpty(image))throw new InvalidOperationException("Process image unavailable");
    return new {pid=p.Id,started=p.StartTime.ToUniversalTime().Ticks.ToString(),visible=IsWindowVisible(w),handle=w.ToInt64().ToString(),image,owned=true};
  }
  static object SuspendedImageFixture(string image) {
    image=Path.GetFullPath(image);if(Path.GetFileName(image)!="mcp-proxy.exe")throw new Exception("Invalid process-image fixture");
    var startup=new STARTUPINFO{size=(uint)Marshal.SizeOf(typeof(STARTUPINFO))};PROCESSINFO created;
    if(!CreateProcess(image,null,IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,Path.GetDirectoryName(image),ref startup,out created))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      // Test-only: a suspended loader has no reliable module enumeration yet.
      using(var p=Process.GetProcessById((int)created.pid)) {
        bool missing;try{missing=p.MainModule==null;}catch(System.ComponentModel.Win32Exception e){if(e.NativeErrorCode!=299)throw;missing=true;}
        return new{pid=p.Id,started=p.StartTime.ToUniversalTime().Ticks.ToString(),mainModuleUnavailable=missing,image=ProcessImage(p)};
      }
    } finally {
      try{if(!TerminateProcess(created.process,0)||WaitForSingleObject(created.process,5000)!=0)throw new Exception("Suspended fixture did not stop");}
      finally{CloseHandle(created.thread);CloseHandle(created.process);}
    }
  }
  static string DesktopName(IntPtr desktop) {uint needed;var b=new StringBuilder(128);return desktop!=IntPtr.Zero&&GetUserObjectInformation(desktop,2,b,(uint)(b.Capacity*2),out needed)?b.ToString():"unavailable";}
  static string SessionState() {
    IntPtr value;uint bytes;
    if(!WTSQuerySessionInformation(IntPtr.Zero,Process.GetCurrentProcess().SessionId,8,out value,out bytes))return "unavailable";
    try {if(bytes<4)return "unavailable";int state=Marshal.ReadInt32(value);return state==0?"active":state==4?"disconnected":"state-"+state;}
    finally{WTSFreeMemory(value);}
  }
  static IntPtr TargetWindow(AutomationElement e,int pid) {
    IntPtr window=IntPtr.Zero;var node=e;
    for(int i=0;i<32&&node!=null;i++,node=TreeWalker.RawViewWalker.GetParent(node))if(node.Current.NativeWindowHandle!=0){window=GetAncestor(new IntPtr(node.Current.NativeWindowHandle),2);break;}
    uint owner;if(window==IntPtr.Zero||!IsWindowVisible(window))throw new Exception("Target root window is unavailable");
    GetWindowThreadProcessId(window,out owner);if(owner!=pid)throw new Exception("Target root window belongs to another process");
    return window;
  }
  static void FocusTarget(AutomationElement e,int pid) {
    var window=TargetWindow(e,pid);
    SetForegroundWindow(window);
    for(int i=0;i<20;i++){if(GetForegroundWindow()==window)return;System.Threading.Thread.Sleep(50);}
    throw new Exception("Target root window could not become foreground");
  }
  static void ConfirmProtocol(AutomationElement target,int pid) {
    if(target.Current.IsOffscreen||!target.Current.IsEnabled)throw new Exception("Protocol button is not available");
    FocusTarget(target,pid);target.SetFocus();
    for(int i=0;i<20;i++) {
      if(target.Current.HasKeyboardFocus&&Automation.Compare(AutomationElement.FocusedElement,target)) {
        var window=TargetWindow(target,pid);var bounds=target.Current.BoundingRectangle;
        // Chromium re-arms dialog input protection on activation. Respect its quiet
        // interval instead of sending an immediately ignored consent or disabling it.
        var stable=Stopwatch.StartNew();long quiet=Math.Max(1000L,(long)GetDoubleClickTime()+100);
        while(stable.ElapsedMilliseconds<quiet) {
          System.Threading.Thread.Sleep(50);
          if(GetForegroundWindow()!=window||!target.Current.HasKeyboardFocus||!Automation.Compare(AutomationElement.FocusedElement,target)
            ||target.Current.BoundingRectangle!=bounds||!target.Current.IsEnabled||target.Current.IsOffscreen)throw new Exception("Protocol focus or bounds changed before consent");
        }
        var down=new INPUT{type=1,value=new INPUTUNION{keyboard=new KEYBDINPUT{key=0x20}}};
        var up=new INPUT{type=1,value=new INPUTUNION{keyboard=new KEYBDINPUT{key=0x20,flags=2}}};
        protocolInputAttempted=true;
        uint sent=SendInput(2,new[]{down,up},Marshal.SizeOf(typeof(INPUT)));
        if(sent!=2) {
          if(sent==1)SendInput(1,new[]{up},Marshal.SizeOf(typeof(INPUT)));
          throw new Exception("Native protocol input result uncertain; refusing retry");
        }
        return;
      }
      System.Threading.Thread.Sleep(50);
    }
    throw new Exception("Protocol button did not acquire keyboard focus");
  }
  static string HitInfo(AutomationElement e) {
    if(e==null)return "none";
    var c=e.Current;var cls=System.Text.RegularExpressions.Regex.Replace(c.ClassName??"","[^A-Za-z0-9_.-]","_");
    return c.ProcessId+"/"+c.ControlType.ProgrammaticName+"/"+cls.Substring(0,Math.Min(64,cls.Length));
  }
  static void Capture(IntPtr window,string filename,System.Windows.Rect? region=null) {
    RECT rect;if(!GetWindowRect(window,out rect))throw new Exception("No owned window bounds");
    using(var image=new Bitmap(rect.right-rect.left,rect.bottom-rect.top))using(var g=Graphics.FromImage(image)){
      var dc=g.GetHdc();try{if(!PrintWindow(window,dc,2))throw new Exception("Window capture failed");}finally{g.ReleaseHdc(dc);}
      if(region.HasValue) {
        var b=region.Value;int left=(int)Math.Ceiling(b.Left),top=(int)Math.Ceiling(b.Top);
        var crop=new Rectangle(left-rect.left,top-rect.top,(int)Math.Floor(b.Right)-left,(int)Math.Floor(b.Bottom)-top);
        if(crop.Width<=0||crop.Height<=0||!new Rectangle(0,0,image.Width,image.Height).Contains(crop))throw new Exception("Protocol crop is outside its owned window");
        using(var part=image.Clone(crop,image.PixelFormat))part.Save(filename,ImageFormat.Png);
      }else image.Save(filename,ImageFormat.Png);
    }
  }
  static void SafeProtocolCapture(AutomationElement target,int pid,string filename) {
    var window=TargetWindow(target,pid);var node=TreeWalker.RawViewWalker.GetParent(target);AutomationElement dialog=null;
    // Capture the smallest protocol subtree containing both consent buttons and its
    // "always allow" checkbox. Never include browser chrome or an entire browser root.
    for(int i=0;i<32&&node!=null;i++,node=TreeWalker.RawViewWalker.GetParent(node)) {
      var checks=node.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.CheckBox));
      if(checks.Count==0)continue;
      var buttons=node.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Button));
      if(buttons.Cast<AutomationElement>().Any(e=>!e.Current.IsOffscreen&&System.Text.RegularExpressions.Regex.IsMatch(e.Current.Name??"","^(Cancel|取消)$",System.Text.RegularExpressions.RegexOptions.IgnoreCase))){dialog=node;break;}
    }
    if(dialog==null)throw new Exception("Protocol-only screenshot region unavailable");
    RECT root;if(!GetWindowRect(window,out root))throw new Exception("No owned protocol window bounds");var bounds=dialog.Current.BoundingRectangle;
    if(bounds.Width>=root.right-root.left||bounds.Height>=root.bottom-root.top)throw new Exception("Refusing entire browser screenshot");
    var edits=AutomationElement.FromHandle(window).FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Edit));
    var addressBars=edits.Cast<AutomationElement>().Where(e=>(e.Current.ClassName??"").IndexOf("Omnibox",StringComparison.OrdinalIgnoreCase)>=0).ToList();
    if(addressBars.Count==0||addressBars.Any(e=>bounds.IntersectsWith(e.Current.BoundingRectangle)))throw new Exception("Address bar exclusion could not be verified");
    var nodes=dialog.FindAll(TreeScope.Subtree,Condition.TrueCondition);
    foreach(AutomationElement item in nodes) {
      string text=item.Current.Name??"";object pattern;
      if(item.TryGetCurrentPattern(ValuePattern.Pattern,out pattern))text+=" "+((ValuePattern)pattern).Current.Value;
      if(System.Text.RegularExpressions.Regex.IsMatch(text,"token=|mcp-proxy://associate/|BEGIN .*PRIVATE KEY|[A-Za-z0-9_-]{43,}",System.Text.RegularExpressions.RegexOptions.IgnoreCase))throw new Exception("Protocol window contains sensitive text; capture refused");
    }
    Capture(window,filename,bounds);
  }
  static void Click(AutomationElement e,bool right=false,bool pointer=false) {
    if(e.Current.IsOffscreen)throw new Exception("Native target is offscreen");
    if(!e.Current.IsEnabled)throw new Exception("Native target is disabled");
    object invoke;if(!pointer&&!right&&e.TryGetCurrentPattern(InvokePattern.Pattern,out invoke)){((InvokePattern)invoke).Invoke();return;}
    var b=e.Current.BoundingRectangle;if(b.Width<=0||b.Height<=0)throw new Exception("No native target bounds");
    var points=new List<System.Windows.Point>();System.Windows.Point suggested;
    if(e.TryGetClickablePoint(out suggested)&&b.Contains(suggested))points.Add(suggested);
    foreach(double y in new[]{0.5,0.25,0.75})foreach(double x in new[]{0.5,0.25,0.75})points.Add(new System.Windows.Point(b.X+b.Width*x,b.Y+b.Height*y));
    System.Windows.Point? selected=null;AutomationElement originalHit=null;
    foreach(var point in points) {
      var hit=AutomationElement.FromPoint(point);originalHit=hit;
      for(int i=0;i<32&&hit!=null;i++,hit=TreeWalker.RawViewWalker.GetParent(hit))if(Automation.Compare(hit,e)){selected=point;break;}
      if(selected.HasValue)break;
    }
    if(!selected.HasValue)throw new Exception("Native control is occluded; target="+HitInfo(e)+"; hit="+HitInfo(originalHit)+"; bounds="+b.X+","+b.Y+","+b.Width+","+b.Height);
    if(!SetCursorPos((int)selected.Value.X,(int)selected.Value.Y))throw new Exception("Native cursor positioning failed");
    mouse_event(right?0x0008u:0x0002u,0,0,0,UIntPtr.Zero);mouse_event(right?0x0010u:0x0004u,0,0,0,UIntPtr.Zero);
  }
  static AutomationElement Button(IEnumerable<IntPtr> windows, string pattern, ControlType type) {
    var found=new List<AutomationElement>();
    foreach(var w in windows) {
      var elements=AutomationElement.FromHandle(w).FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,type));
      foreach(AutomationElement e in elements)if(!e.Current.IsOffscreen&&System.Text.RegularExpressions.Regex.IsMatch(e.Current.Name??"",pattern,System.Text.RegularExpressions.RegexOptions.IgnoreCase))found.Add(e);
    }
    if(found.Count!=1)throw new Exception("Expected one matching native control; found "+found.Count);return found[0];
  }
  static List<IntPtr> TrayWindows() {
    var shell=FindWindow("Shell_TrayWnd",null);uint shellPid;GetWindowThreadProcessId(shell,out shellPid);
    if(shell==IntPtr.Zero||shellPid==0)throw new Exception("Notification area unavailable");
    var rows=new List<IntPtr>();EnumWindows((w,a)=>{var b=new StringBuilder(256);GetClassName(w,b,b.Capacity);var c=b.ToString();uint pid;GetWindowThreadProcessId(w,out pid);
      if(shellPid!=0&&pid==shellPid&&IsWindowVisible(w)&&(w==shell||c=="Shell_SecondaryTrayWnd"||c=="NotifyIconOverflowWindow"||c.Contains("Overflow")||c=="Xaml_WindowedPopupClass"))rows.Add(w);return true;},IntPtr.Zero);return rows;
  }
  static AutomationElement Tray() {
    var icons=TrayIcons();if(icons.Count>1)throw new Exception("Notification icon is not unique");if(icons.Count==1)return icons[0];
    if(!OverflowVisible()) {var chevron=OverflowOpener();if(chevron==null)throw new Exception("Notification overflow opener unavailable");ExpandOverflow(chevron);}
    for(int i=0;i<40;i++) {icons=TrayIcons();if(icons.Count>1)throw new Exception("Notification icon is not unique");if(icons.Count==1)return icons[0];System.Threading.Thread.Sleep(50);}
    throw new Exception("Notification overflow opened but test icon unavailable");
  }
  static AutomationElement OverflowOpener() {
    var modern=new List<AutomationElement>();var legacy=new List<AutomationElement>();
    foreach(var w in TrayWindows())foreach(AutomationElement e in AutomationElement.FromHandle(w).FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Button))) {
      var c=e.Current;if(c.IsOffscreen)continue;
      if(c.AutomationId=="SystemTray.OverflowButton")modern.Add(e);
      else if(System.Text.RegularExpressions.Regex.IsMatch(c.Name??"","hidden icons|hidden icon menu|显示隐藏|隐藏的图标|隐藏图标菜单",System.Text.RegularExpressions.RegexOptions.IgnoreCase))legacy.Add(e);
    }
    var found=modern.Count>0?modern:legacy;if(found.Count>1)throw new Exception("Notification overflow control is not unique");return found.Count==0?null:found[0];
  }
  static bool OverflowVisible() {
    foreach(var w in TrayWindows()) {
      var cls=new StringBuilder(256);GetClassName(w,cls,cls.Capacity);
      if(cls.ToString().Contains("Overflow"))return true;
      if(cls.ToString()=="Xaml_WindowedPopupClass")foreach(AutomationElement e in AutomationElement.FromHandle(w).FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Button)))if(!e.Current.IsOffscreen&&(e.Current.AutomationId=="SystemTrayIcon"||e.Current.AutomationId=="NotifyItemIcon"))return true;
    }
    return false;
  }
  static void ExpandOverflow(AutomationElement opener) {
    Click(opener);for(int i=0;i<40;i++){if(OverflowVisible())return;System.Threading.Thread.Sleep(50);}throw new Exception("Notification overflow did not become visible");
  }
  static bool TrayPresent() {
    if(TrayIcons().Count>0)return true;
    if(OverflowVisible())return false;
    var opener=OverflowOpener();if(opener==null)return false;
    try{ExpandOverflow(opener);return TrayIcons().Count>0;}
    finally {
      if(OverflowVisible())Click(opener);
      for(int i=0;i<40&&OverflowVisible();i++)System.Threading.Thread.Sleep(50);
      if(OverflowVisible())throw new Exception("Test-opened notification overflow remained visible");
    }
  }
  static List<AutomationElement> TrayIcons() {
    var found=new List<AutomationElement>();
    foreach(var w in TrayWindows()) {
      var cls=new StringBuilder(256);GetClassName(w,cls,cls.Capacity);bool generic=cls.ToString()=="Xaml_WindowedPopupClass";
      foreach(AutomationElement e in AutomationElement.FromHandle(w).FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Button))) {
        var c=e.Current;if(c.IsOffscreen||(!TrayLabel(c.Name)&&!TrayLabel(c.HelpText)))continue;
        if(generic&&c.AutomationId!="SystemTrayIcon"&&c.AutomationId!="NotifyItemIcon")continue;
        found.Add(e);
      }
    }
    return found;
  }
  static bool TrayLabel(string text) {
    text=(text??"").Trim();return String.Equals(text,"mcp-proxy",StringComparison.OrdinalIgnoreCase)||String.Equals(text,"mcp-proxy.exe",StringComparison.OrdinalIgnoreCase);
  }
  static string TrayTextKind(string text) {
    if(String.IsNullOrWhiteSpace(text))return "empty";if(TrayLabel(text))return "test-icon";
    if(text.IndexOf("mcp-proxy",StringComparison.OrdinalIgnoreCase)>=0)return "contains-brand";
    return text.Trim().Equals("Electron",StringComparison.OrdinalIgnoreCase)?"electron":"other";
  }
  static object TrayInfo() {
    var rows=new List<object>();
    foreach(var w in TrayWindows())foreach(AutomationElement e in AutomationElement.FromHandle(w).FindAll(TreeScope.Descendants,Condition.TrueCondition)) {
      var c=e.Current;if(c.IsOffscreen)continue;
      if(c.ControlType!=ControlType.Button&&c.ControlType!=ControlType.Custom&&c.ControlType!=ControlType.ToolBar)continue;
      var id=c.AutomationId??"";if(!System.Text.RegularExpressions.Regex.IsMatch(id,"\\A[A-Za-z0-9_.-]{0,96}\\z")||System.Text.RegularExpressions.Regex.IsMatch(id,"[A-Za-z0-9_-]{43,}"))id="redacted";
      var rootClass=new StringBuilder(256);GetClassName(w,rootClass,rootClass.Capacity);
      rows.Add(new{windowClass=rootClass.ToString(),type=c.ControlType.ProgrammaticName,automationId=id,nameKind=TrayTextKind(c.Name),helpKind=TrayTextKind(c.HelpText)});
      if(rows.Count>=80)return rows;
    }
    return rows;
  }
  static object Certificate(string op,string value) {
    using(var store=new X509Store(StoreName.Root,StoreLocation.CurrentUser)) {
      store.Open(OpenFlags.ReadWrite);
      if(op=="ca-add") {
        var text=File.ReadAllText(value);var body=text.Replace("-----BEGIN CERTIFICATE-----","").Replace("-----END CERTIFICATE-----","");
        using(var cert=new X509Certificate2(Convert.FromBase64String(body))) {
          if(store.Certificates.Find(X509FindType.FindByThumbprint,cert.Thumbprint,false).Count!=0)throw new Exception("Certificate already exists; not owned");
          store.Add(cert);return new {thumbprint=cert.Thumbprint,added=true};
        }
      }
      if(!System.Text.RegularExpressions.Regex.IsMatch(value,"\\A[A-F0-9]{40}\\z"))throw new Exception("Invalid owned certificate identity");
      foreach(var cert in store.Certificates.Find(X509FindType.FindByThumbprint,value,false))store.Remove(cert);
      if(store.Certificates.Find(X509FindType.FindByThumbprint,value,false).Count!=0)throw new Exception("Certificate removal failed");
      return new {removed=true};
    }
  }
  [STAThread] static int Main(string[] a) {
    Console.OutputEncoding=new UTF8Encoding(false);Console.InputEncoding=new UTF8Encoding(false);
    SetProcessDPIAware();
    try {
      object result=null;var op=a[0];
      if(op=="preflight") {
        var d=OpenInputDesktop(0,false,0x0001);string input=DesktopName(d),thread=DesktopName(GetThreadDesktop(GetCurrentThreadId()));if(d!=IntPtr.Zero)CloseDesktop(d);
        string session=SessionState();
        using(var key=Registry.ClassesRoot.OpenSubKey("mcp-proxy"))result=new {platform="win32",interactive=Environment.UserInteractive&&Process.GetCurrentProcess().SessionId!=0&&session=="active"&&input!="unavailable"&&input==thread,sessionState=session,inputDesktop=input,processDesktop=thread,tray=FindWindow("Shell_TrayWnd",null)!=IntPtr.Zero,uriOccupied=key!=null};
      } else if(op=="protect-state") {
        if((File.GetAttributes(a[1])&FileAttributes.ReparsePoint)!=0)throw new Exception("Linked state directory");
        var acl=new DirectorySecurity();acl.SetAccessRuleProtection(true,false);
        foreach(var sid in new[]{WindowsIdentity.GetCurrent().User,new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null)})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        Directory.SetAccessControl(a[1],acl);result=new{protectedState=true};
      } else if(op=="process-image-fixture")result=SuspendedImageFixture(a[1]);
      else if(op.StartsWith("ca-"))result=Certificate(op,a[1]);
      else if(op=="alive") {try {var p=Process.GetProcessById(Int32.Parse(a[1]));result=p.StartTime.ToUniversalTime().Ticks.ToString()==a[2];}catch(ArgumentException){result=false;}}
      else if(op=="identity") {try{var p=Process.GetProcessById(Int32.Parse(a[1]));var image=ProcessImage(p);result=String.IsNullOrEmpty(image)?null:new {pid=p.Id,started=p.StartTime.ToUniversalTime().Ticks.ToString(),image};}catch(ArgumentException){result=null;}}
      else if(op=="tray-present")result=TrayPresent();
      else if(op=="tray-info")result=TrayInfo();
      else if(op=="gui"||op=="scope-processes") {
        string root=Path.GetFullPath(a[1]).TrimEnd('\\')+"\\";var rows=new List<object>();
        foreach(var p in op=="gui"?Process.GetProcessesByName("mcp-proxy"):Process.GetProcesses())try {var image=ProcessImage(p);if(!String.IsNullOrEmpty(image)&&image.StartsWith(root,StringComparison.OrdinalIgnoreCase)){if(op=="scope-processes")rows.Add(new{pid=p.Id,started=p.StartTime.ToUniversalTime().Ticks.ToString()});else foreach(var w in Windows(p.Id))if(Title(w)=="mcp-proxy")rows.Add(Info(p,w,image));} }catch(System.ComponentModel.Win32Exception){}catch(InvalidOperationException){}
        result=rows;
      } else {
        var p=Owned(a);var windows=Windows(p.Id);var own=windows.Where(w=>Title(w)=="mcp-proxy").ToList();
        if(op=="children") {
          var ids=new HashSet<int>();ids.Add(p.Id);var parents=new Dictionary<int,int>();var snap=CreateToolhelp32Snapshot(2,0);
          if(snap==new IntPtr(-1))throw new Exception("Cannot snapshot owned process tree");
          try {var entry=new PE();entry.size=(uint)Marshal.SizeOf(typeof(PE));if(Process32First(snap,ref entry))do{parents[(int)entry.pid]=(int)entry.parent;}while(Process32Next(snap,ref entry));}
          finally{CloseHandle(snap);}
          bool changed;do{changed=false;foreach(var row in parents)if(ids.Contains(row.Value)&&ids.Add(row.Key))changed=true;}while(changed);
          var rows=new List<object>();foreach(int id in ids)try{var item=Process.GetProcessById(id);if(item.StartTime>=p.StartTime)rows.Add(new {pid=id,started=item.StartTime.ToUniversalTime().Ticks.ToString()});}catch(ArgumentException){}
          result=rows;
        }
        else if(op=="close-window") {if(own.Count!=1)throw new Exception("GUI window is not unique");PostMessage(own[0],0x0010,IntPtr.Zero,IntPtr.Zero);}
        else if(op=="confirm-protocol") {ConfirmProtocol(Button(windows,"^(Open|打开).*mcp-proxy",ControlType.Button),p.Id);}
        else if(op=="protocol-prompt") {try{Button(windows,"^(Open|打开).*mcp-proxy",ControlType.Button);result=true;}catch{result=false;}}
        else if(op=="screenshot-protocol") {SafeProtocolCapture(Button(windows,"^(Open|打开).*mcp-proxy",ControlType.Button),p.Id,a[3]);result=new{captured=true};}
        else if(op=="confirm-ca") {
          var dialogs=new List<IntPtr>();foreach(var w in windows){var names=AutomationElement.FromHandle(w).FindAll(TreeScope.Descendants,Condition.TrueCondition);foreach(AutomationElement e in names)if((e.Current.Name??"").Contains("MCP Proxy Project Development CA")){dialogs.Add(w);break;}}
          if(dialogs.Count!=1)throw new Exception("Owned test CA warning not found");SetForegroundWindow(dialogs[0]);Click(Button(dialogs,"^(Yes|是|是\\(Y\\)|是\\(&Y\\))$",ControlType.Button));
        }
        else if(op=="disconnect") {if(own.Count!=1)throw new Exception("GUI window is not unique");SetForegroundWindow(own[0]);Click(Button(own,"^(Disconnect|断开)$",ControlType.Button));}
        else if(op=="show-mcps"||op=="show-connections") {if(own.Count!=1)throw new Exception("GUI window is not unique");SetForegroundWindow(own[0]);Click(Button(own,op=="show-mcps"?"^(Local MCPs|本地 MCP)$":"^(DSH connections|DSH 连接)$",ControlType.Button));}
        else if(op=="gui-connected") {
          if(own.Count!=1)throw new Exception("GUI window is not unique");
          var names=new List<string>();foreach(AutomationElement e in AutomationElement.FromHandle(own[0]).FindAll(TreeScope.Descendants,Condition.TrueCondition))names.Add(e.Current.Name??"");
          result=new {originVisible=names.Any(n=>n.Contains(a[3])),serviceVisible=names.Any(n=>n=="files"),connectedVisible=names.Any(n=>n=="Connected"||n=="已连接")};
        }
        else if(op=="screenshot") {
          if(own.Count!=1||!IsWindowVisible(own[0]))throw new Exception("Owned GUI not visible");Capture(own[0],a[3]);result=new{captured=true};
        }
        else if(op=="confirm-disconnect")Click(Button(windows,"^(OK|确定)$",ControlType.Button));
        else if(op=="tray-click")Click(Tray(),false,true);
        else if(op=="tray-exit") {
          Click(Tray(),true);System.Threading.Thread.Sleep(300);
          var menus=AutomationElement.RootElement.FindAll(TreeScope.Children,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Menu));
          var items=new List<AutomationElement>();foreach(AutomationElement menu in menus)if(menu.Current.ProcessId==p.Id)foreach(AutomationElement e in menu.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.MenuItem)))if(System.Text.RegularExpressions.Regex.IsMatch(e.Current.Name??"","^(Exit|退出)$"))items.Add(e);
          if(items.Count!=1)throw new Exception("Owned tray Exit menu is not unique");Click(items[0]);
        } else if(op=="window") {if(own.Count!=1)throw new Exception("GUI window is not unique");result=Info(p,own[0]);}
        else if(op=="close-browser") {foreach(var w in windows)PostMessage(w,0x0010,IntPtr.Zero,IntPtr.Zero);}
        else if(op=="kill-owned")p.Kill();
        else throw new Exception("Unknown native test operation");
        if(result==null)result=new {ok=true};
      }
      Console.WriteLine(new JavaScriptSerializer().Serialize(result));return 0;
    }catch(Exception e){Console.Error.WriteLine(protocolInputAttempted?"Native desktop test: Exception: Native protocol input result uncertain; refusing retry":"Native desktop test: "+e.GetType().Name+": "+e.Message);return 1;}
  }
}
