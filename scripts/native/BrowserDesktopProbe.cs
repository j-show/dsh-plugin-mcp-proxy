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
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct PE {public uint size,usage,pid;public IntPtr heap;public uint module,threads,parent;public int priority;public uint flags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string exe;}
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32First(IntPtr snap,ref PE entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32Next(IntPtr snap,ref PE entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("user32.dll")] static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr w);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow cb, IntPtr arg);
  delegate bool EnumWindow(IntPtr w, IntPtr arg);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr w, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr w, StringBuilder b, int n);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr w, uint m, IntPtr a, IntPtr b);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr w);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)]struct RECT {public int left,top,right,bottom;}
  [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr w,out RECT rect);
  [DllImport("user32.dll")]static extern bool PrintWindow(IntPtr w,IntPtr dc,uint flags);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr w, StringBuilder b, int n);
  static string Title(IntPtr w) { var b=new StringBuilder(1024); GetWindowText(w,b,b.Capacity); return b.ToString(); }
  static List<IntPtr> Windows(int pid) {
    var result=new List<IntPtr>(); EnumWindows((w,a)=>{uint p;GetWindowThreadProcessId(w,out p);if(p==pid)result.Add(w);return true;},IntPtr.Zero);return result;
  }
  static Process Owned(string[] a) {
    var p=Process.GetProcessById(Int32.Parse(a[1]));
    if(p.StartTime.ToUniversalTime().Ticks.ToString()!=a[2])throw new Exception("Process identity changed");return p;
  }
  static object Info(Process p, IntPtr w) { return new {pid=p.Id,started=p.StartTime.ToUniversalTime().Ticks.ToString(),visible=IsWindowVisible(w),handle=w.ToInt64().ToString(),image=p.MainModule.FileName,owned=true}; }
  static void Click(AutomationElement e,bool right=false,bool pointer=false) {
    if(e.Current.IsOffscreen)throw new Exception("Native target is offscreen");
    object invoke;if(!pointer&&!right&&e.TryGetCurrentPattern(InvokePattern.Pattern,out invoke)){((InvokePattern)invoke).Invoke();return;}
    var b=e.Current.BoundingRectangle;if(b.Width<=0||b.Height<=0)throw new Exception("No native target bounds");
    var hit=AutomationElement.FromPoint(new System.Windows.Point(b.X+b.Width/2,b.Y+b.Height/2));bool target=false;
    for(int i=0;i<8&&hit!=null;i++,hit=TreeWalker.RawViewWalker.GetParent(hit))if(Automation.Compare(hit,e)){target=true;break;}
    if(!target)throw new Exception("Native control is occluded; refusing pointer input");
    SetCursorPos((int)(b.X+b.Width/2),(int)(b.Y+b.Height/2));
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
    var rows=new List<IntPtr>();EnumWindows((w,a)=>{var b=new StringBuilder(256);GetClassName(w,b,b.Capacity);var c=b.ToString();if(IsWindowVisible(w)&&(c=="Shell_TrayWnd"||c=="NotifyIconOverflowWindow"||c.Contains("Overflow")))rows.Add(w);return true;},IntPtr.Zero);return rows;
  }
  static AutomationElement Tray() {
    try{return Button(TrayWindows(),"^mcp-proxy",ControlType.Button);}catch {
      var chevron=Button(TrayWindows(),"hidden icons|显示隐藏|隐藏的图标",ControlType.Button);Click(chevron);System.Threading.Thread.Sleep(300);
      return Button(TrayWindows(),"^mcp-proxy",ControlType.Button);
    }
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
        var d=OpenInputDesktop(0,false,0x0001);bool input=d!=IntPtr.Zero;if(input)CloseDesktop(d);
        using(var key=Registry.CurrentUser.OpenSubKey("Software\\Classes\\mcp-proxy"))result=new {platform="win32",interactive=Environment.UserInteractive&&Process.GetCurrentProcess().SessionId!=0&&input,tray=FindWindow("Shell_TrayWnd",null)!=IntPtr.Zero,uriOccupied=key!=null};
      } else if(op=="protect-state") {
        if((File.GetAttributes(a[1])&FileAttributes.ReparsePoint)!=0)throw new Exception("Linked state directory");
        var acl=new DirectorySecurity();acl.SetAccessRuleProtection(true,false);
        foreach(var sid in new[]{WindowsIdentity.GetCurrent().User,new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null)})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        Directory.SetAccessControl(a[1],acl);result=new{protectedState=true};
      } else if(op.StartsWith("ca-"))result=Certificate(op,a[1]);
      else if(op=="alive") {try {var p=Process.GetProcessById(Int32.Parse(a[1]));result=p.StartTime.ToUniversalTime().Ticks.ToString()==a[2];}catch(ArgumentException){result=false;}}
      else if(op=="identity") {try{var p=Process.GetProcessById(Int32.Parse(a[1]));result=new {pid=p.Id,started=p.StartTime.ToUniversalTime().Ticks.ToString(),image=p.MainModule.FileName};}catch(ArgumentException){result=null;}}
      else if(op=="tray-present") {try{Button(TrayWindows(),"^mcp-proxy",ControlType.Button);result=true;}catch{result=false;}}
      else if(op=="gui"||op=="scope-processes") {
        string root=Path.GetFullPath(a[1]).TrimEnd('\\')+"\\";var rows=new List<object>();
        foreach(var p in op=="gui"?Process.GetProcessesByName("mcp-proxy"):Process.GetProcesses())try { if(p.MainModule.FileName.StartsWith(root,StringComparison.OrdinalIgnoreCase)){if(op=="scope-processes")rows.Add(new{pid=p.Id,started=p.StartTime.ToUniversalTime().Ticks.ToString()});else foreach(var w in Windows(p.Id))if(Title(w)=="mcp-proxy")rows.Add(Info(p,w));} }catch(System.ComponentModel.Win32Exception){}catch(InvalidOperationException){}
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
        else if(op=="confirm-protocol") {if(windows.Count==0)throw new Exception("Browser has no native window");SetForegroundWindow(windows[0]);Click(Button(windows,"^(Open|打开).*mcp-proxy",ControlType.Button));}
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
          if(own.Count!=1||!IsWindowVisible(own[0]))throw new Exception("Owned GUI not visible");RECT rect;if(!GetWindowRect(own[0],out rect))throw new Exception("No GUI bounds");
          using(var image=new Bitmap(rect.right-rect.left,rect.bottom-rect.top))using(var g=Graphics.FromImage(image)){var dc=g.GetHdc();try{if(!PrintWindow(own[0],dc,2))throw new Exception("Window capture failed");}finally{g.ReleaseHdc(dc);}image.Save(a[3],ImageFormat.Png);}result=new{captured=true};
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
    }catch(Exception e){Console.Error.WriteLine("Native desktop test: "+e.GetType().Name+": "+e.Message);return 1;}
  }
}
