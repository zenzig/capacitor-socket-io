import { CapacitorSocketIO } from '@zenzig/capacitor-socket-io';

window.testEcho = () => {
    const inputValue = document.getElementById("echoInput").value;
    CapacitorSocketIO.echo({ value: inputValue })
}
