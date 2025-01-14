/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2023-2024 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { timeout } from 'vs/base/common/async';
import { Emitter } from 'vs/base/common/event';
import { URI } from 'vs/base/common/uri';
import { ensureNoDisposablesAreLeakedInTestSuite } from 'vs/base/test/common/utils';
import { TestInstantiationService } from 'vs/platform/instantiation/test/common/instantiationServiceMock';
import { ILogService } from 'vs/platform/log/common/log';
import { INotebookEditor } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { INotebookEditorService } from 'vs/workbench/contrib/notebook/browser/services/notebookEditorService';
import { NotebookTextModel } from 'vs/workbench/contrib/notebook/common/model/notebookTextModel';
import { INotebookService } from 'vs/workbench/contrib/notebook/common/notebookService';
import { IPyWidgetsInstance, PositronIPyWidgetsService } from 'vs/workbench/contrib/positronIPyWidgets/browser/positronIPyWidgetsService';
import { NotebookOutputPlotClient } from 'vs/workbench/contrib/positronPlots/browser/notebookOutputPlotClient';
import { RuntimeClientState } from 'vs/workbench/services/languageRuntime/common/languageRuntimeClientInstance';
import { ILanguageRuntimeMessageClearOutput, ILanguageRuntimeMessageError, ILanguageRuntimeMessageOutput, ILanguageRuntimeMessageResult, ILanguageRuntimeMessageStream, LanguageRuntimeMessageType, LanguageRuntimeSessionMode, RuntimeOutputKind } from 'vs/workbench/services/languageRuntime/common/languageRuntimeService';
import { ToWebviewMessage } from 'vs/workbench/services/languageRuntime/common/positronIPyWidgetsWebviewMessages';
import { TestIPyWidgetsWebviewMessaging } from 'vs/workbench/services/languageRuntime/test/common/testIPyWidgetsWebviewMessaging';
import { RuntimeClientType } from 'vs/workbench/services/runtimeSession/common/runtimeSessionService';
import { TestLanguageRuntimeSession } from 'vs/workbench/services/runtimeSession/test/common/testLanguageRuntimeSession';
import { startTestLanguageRuntimeSession } from 'vs/workbench/services/runtimeSession/test/common/testRuntimeSessionService';
import { PositronTestServiceAccessor, positronWorkbenchInstantiationService } from 'vs/workbench/test/browser/positronWorkbenchTestServices';
import { TestNotebookService } from 'vs/workbench/test/common/positronWorkbenchTestServices';

interface TestNotebookEditor extends INotebookEditor {
	changeModel(uri: URI): void;
}

suite('Positron - PositronIPyWidgetsService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let instantiationService: TestInstantiationService;
	let positronIpywidgetsService: PositronIPyWidgetsService;
	let notebookEditorService: INotebookEditorService;

	setup(() => {
		instantiationService = positronWorkbenchInstantiationService(disposables);
		const accessor = instantiationService.createInstance(PositronTestServiceAccessor);
		notebookEditorService = accessor.notebookEditorService;
		positronIpywidgetsService = accessor.positronIPyWidgetsService;
	});

	async function receiveIPyWidgetsResultMessage(
		session: TestLanguageRuntimeSession,
		parentId?: string,
	) {
		// Simulate the runtime sending a result message to the parent ID
		// that the output client will handle.
		const message = session.receiveResultMessage({
			parent_id: parentId,
			kind: RuntimeOutputKind.IPyWidget,
			data: {
				'application/vnd.jupyter.widget-view+json': {},
			},
		});
		await timeout(0);

		return message;
	}

	async function createConsoleInstance() {
		// Listen for the plot client to be created.
		let plotClient: NotebookOutputPlotClient | undefined;
		disposables.add(positronIpywidgetsService.onDidCreatePlot(client => plotClient = client));

		// Start a console session.
		const session = await startTestLanguageRuntimeSession(instantiationService, disposables);

		// Simulate the runtime sending an IPyWidgets output message.
		const message = await receiveIPyWidgetsResultMessage(session);

		// Check that an instance was created with the expected properties.
		assert(positronIpywidgetsService.hasInstance(message.id));
		assert(!!plotClient);
		assert.strictEqual(plotClient.id, message.id);
		assert.deepStrictEqual(plotClient.metadata, {
			id: message.id,
			parent_id: message.parent_id,
			created: Date.parse(message.when),
			session_id: session.sessionId,
			code: '',
		});

		return { session, plotClient };
	}

	test('console session: create and end session', async () => {
		const { session, plotClient } = await createConsoleInstance();

		// End the session.
		session.endSession();
		await timeout(0);

		// Check that the instance was removed.
		assert(!positronIpywidgetsService.hasInstance(plotClient.id));
	});

	test('console session: respond to result message type and check for memory leaks', async () => {
		const { session } = await createConsoleInstance();

		// Simulate the runtime sending a result message.
		const message = session.receiveResultMessage({
			kind: RuntimeOutputKind.IPyWidget,
			data: {
				'application/vnd.jupyter.widget-view+json': {},
			},
		});

		await timeout(0);

		assert(positronIpywidgetsService.hasInstance(message.id));
		// Note that we don't end the session here. This helps us check for memory leaks caused by
		// improper disposal of listeners
	});


	test('notebook session: check for memory leaks', async () => {
		const { session } = await createNotebookInstance();

		await timeout(0);

		assert(positronIpywidgetsService.hasInstance(session.sessionId));
		// Note that we don't end the session here. This helps us check for memory leaks caused by
		// improper disposal of listeners
	});

	async function createNotebookInstance() {
		const notebookUri = URI.file('notebook.ipynb');

		// Add a mock notebook editor.
		const onDidChangeModel = disposables.add(new Emitter<NotebookTextModel | undefined>());
		const notebookEditor = <TestNotebookEditor>{
			getId() { return 'test-notebook-editor-id'; },
			onDidChangeModel: onDidChangeModel.event,
			textModel: { uri: notebookUri },
			changeModel(uri) { onDidChangeModel.fire(<NotebookTextModel>{ uri }); },
		};
		notebookEditorService.addNotebookEditor(notebookEditor);

		// Start a notebook session.
		const session = await startTestLanguageRuntimeSession(
			instantiationService,
			disposables,
			{ sessionMode: LanguageRuntimeSessionMode.Notebook, notebookUri },
		);

		// Check that an instance was created.
		assert(positronIpywidgetsService.hasInstance(session.sessionId));

		return { session, notebookEditor };
	}

	test('notebook session: create and end session', async () => {
		const { session } = await createNotebookInstance();

		// Check that an instance was created.
		assert(positronIpywidgetsService.hasInstance(session.sessionId));

		// End the session.
		session.endSession();
		await timeout(0);

		// Check that the instance was removed.
		assert(!positronIpywidgetsService.hasInstance(session.sessionId));
	});

	test('notebook session: change notebook text model', async () => {
		const { session, notebookEditor } = await createNotebookInstance();

		// Change the notebook's text model.
		notebookEditor.changeModel(URI.file('other.ipynb'));
		await timeout(0);

		// Check that the instance was removed.
		assert(!positronIpywidgetsService.hasInstance(session.sessionId));
	});

	test('notebook session: remove notebook editor', async () => {
		const { session, notebookEditor } = await createNotebookInstance();

		// Check that an instance was created.
		assert(positronIpywidgetsService.hasInstance(session.sessionId));

		// Remove notebook editor.
		notebookEditorService.removeNotebookEditor(notebookEditor);
		await timeout(0);

		// Check that the instance was removed.
		assert(!positronIpywidgetsService.hasInstance(session.sessionId));
	});

});

suite('Positron - IPyWidgetsInstance constructor', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let logService: ILogService;
	let session: TestLanguageRuntimeSession;
	let messaging: TestIPyWidgetsWebviewMessaging;
	let notebookService: INotebookService;

	setup(async () => {
		const instantiationService = positronWorkbenchInstantiationService(disposables);
		const accessor = instantiationService.createInstance(PositronTestServiceAccessor);
		logService = accessor.logService;
		session = await startTestLanguageRuntimeSession(instantiationService, disposables);
		messaging = disposables.add(new TestIPyWidgetsWebviewMessaging());
		notebookService = new TestNotebookService() as INotebookService;
	});

	async function createIPyWidgetsInstance() {
		const ipywidgetsInstance = disposables.add(new IPyWidgetsInstance(session, messaging, notebookService, logService));
		await timeout(0);
		return ipywidgetsInstance;
	}

	test('initialized session, no clients', async () => {
		// Create an instance.
		await createIPyWidgetsInstance();

		// Check that the initialize message was sent.
		assert.deepStrictEqual(messaging.messagesToWebview, [{ type: 'initialize_result' }]);
	});

	test('initialized session, one ipywidget client', async () => {
		const client = await session.createClient(RuntimeClientType.IPyWidget, {}, {}, 'test-client-id');

		// Create an instance.
		const ipywidgetsInstance = await createIPyWidgetsInstance();

		// Check that the initialize message was sent.
		assert.deepStrictEqual(messaging.messagesToWebview, [{ type: 'initialize_result' }]);

		// Check that the client was registered.
		assert(ipywidgetsInstance.hasClient(client.getClientId()));

		// Close the client.
		client.setClientState(RuntimeClientState.Closed);
		await timeout(0);

		// Check that the client was removed.
		assert(!ipywidgetsInstance.hasClient(client.getClientId()));
	});
});

suite('Positron - IPyWidgetsInstance', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let session: TestLanguageRuntimeSession;
	let messaging: TestIPyWidgetsWebviewMessaging;
	let ipywidgetsInstance: IPyWidgetsInstance;

	setup(async () => {
		const instantiationService = positronWorkbenchInstantiationService(disposables);
		const accessor = instantiationService.createInstance(PositronTestServiceAccessor);
		session = await startTestLanguageRuntimeSession(instantiationService, disposables);
		messaging = disposables.add(new TestIPyWidgetsWebviewMessaging());
		const notebookService = new TestNotebookService() as INotebookService;
		ipywidgetsInstance = disposables.add(new IPyWidgetsInstance(
			session,
			messaging,
			notebookService,
			accessor.logService,
		));

		// Clear initial messages.
		messaging.messagesToWebview.splice(0);
	});

	test('from webview: initialize_request', async () => {
		// Simulate the webview sending an initialize request.
		messaging.receiveMessage({ type: 'initialize' });

		// Check that the initialize result was sent.
		assert.deepStrictEqual(messaging.messagesToWebview, [{ type: 'initialize_result' }]);
	});

	test('from webview: comm_open jupyter.widget.control', async () => {
		// Simulate the webview sending a comm open.
		const clientId = 'test-client-id';
		messaging.receiveMessage({
			type: 'comm_open',
			comm_id: clientId,
			target_name: RuntimeClientType.IPyWidgetControl,
			data: {},
			metadata: {},
		});
		await timeout(0);

		// Check that the client was registered.
		assert(ipywidgetsInstance.hasClient(clientId));
	});

	test('from webview: comm_open unrelated type', async () => {
		// Simulate the webview sending a comm open of an unrelated comm type.
		const clientId = 'test-client-id';
		messaging.receiveMessage({
			type: 'comm_open',
			comm_id: clientId,
			target_name: RuntimeClientType.Plot,
			data: {},
			metadata: {},
		});
		await timeout(0);

		// Check that the client was *not* registered.
		assert(!ipywidgetsInstance.hasClient(clientId));
	});

	test('from webview: get_preferred_renderer', async () => {
		// Simulate the webview sending a get preferred renderer message.
		const msgId = 'test-msg-id';
		messaging.receiveMessage({
			type: 'get_preferred_renderer',
			msg_id: msgId,
			mime_type: 'test-mime-type',
		});

		// Check that the initialize result was sent.
		assert.deepStrictEqual(messaging.messagesToWebview, [{
			type: 'get_preferred_renderer_result',
			parent_id: msgId,
			// The positron-ipywidgets renderer ID is currently always returned by
			// TestNotebookService.getPreferredRenderer.
			renderer_id: 'positron-ipywidgets',
		} as ToWebviewMessage]);
	});

	test('to webview: comm_open', async () => {
		// Create a client.
		const client = await session.createClient(RuntimeClientType.IPyWidget, {}, {}, 'test-client-id');
		await timeout(0);

		// Check that the client was registered.
		assert(ipywidgetsInstance.hasClient(client.getClientId()));

		// Check that the comm open message was sent to the webview.
		assert.deepStrictEqual(messaging.messagesToWebview, [{
			type: 'comm_open',
			comm_id: client.getClientId(),
			target_name: client.getClientType(),
			data: {},
			metadata: {},
		} as ToWebviewMessage]);

		// Close the client.
		client.setClientState(RuntimeClientState.Closed);
		await timeout(0);

		// Check that the client was removed.
		assert(!ipywidgetsInstance.hasClient(client.getClientId()));
	});

	test('to webview: kernel_message, display_data', async () => {
		const ipywidgetMessage = session.receiveIPyWidgetMessage({}, { type: LanguageRuntimeMessageType.Output });
		const message = ipywidgetMessage.original_message as ILanguageRuntimeMessageOutput;

		// Check that the display_data kernel_message was sent to the webview.
		assert.deepStrictEqual(messaging.messagesToWebview, [{
			type: 'kernel_message',
			parent_id: message.parent_id,
			content: {
				type: 'display_data',
				data: message.data,
				metadata: message.metadata,
			}
		} as ToWebviewMessage]);
	});

	test('to webview: kernel_message, execute_result', async () => {
		const ipywidgetMessage = session.receiveIPyWidgetMessage({}, { type: LanguageRuntimeMessageType.Result });
		const message = ipywidgetMessage.original_message as ILanguageRuntimeMessageResult;

		// Check that the display_data kernel_message was sent to the webview.
		assert.deepStrictEqual(messaging.messagesToWebview, [{
			type: 'kernel_message',
			parent_id: message.parent_id,
			content: {
				type: 'execute_result',
				data: message.data,
				metadata: message.metadata,
			}
		} as ToWebviewMessage]);
	});

	test('to webview: kernel_message, stream', async () => {
		const ipywidgetMessage = session.receiveIPyWidgetMessage({}, { type: LanguageRuntimeMessageType.Stream });
		const message = ipywidgetMessage.original_message as ILanguageRuntimeMessageStream;

		// Check that the stream kernel_message was sent to the webview.
		assert.deepStrictEqual(messaging.messagesToWebview, [{
			type: 'kernel_message',
			parent_id: message.parent_id,
			content: {
				type: 'stream',
				name: message.name,
				text: message.text,
			}
		} as ToWebviewMessage]);
	});

	test('to webview: kernel_message, error', async () => {
		const ipywidgetMessage = session.receiveIPyWidgetMessage({}, { type: LanguageRuntimeMessageType.Error });
		const message = ipywidgetMessage.original_message as ILanguageRuntimeMessageError;

		// Check that the error kernel_message was sent to the webview.
		assert.deepStrictEqual(messaging.messagesToWebview, [{
			type: 'kernel_message',
			parent_id: message.parent_id,
			content: {
				type: 'error',
				name: message.name,
				message: message.message,
				traceback: message.traceback,
			}
		} as ToWebviewMessage]);
	});

	test('to webview: kernel_message, clear_output', async () => {
		const ipywidgetMessage = session.receiveIPyWidgetMessage({}, { type: LanguageRuntimeMessageType.ClearOutput });
		const message = ipywidgetMessage.original_message as ILanguageRuntimeMessageClearOutput;

		// Check that the clear_output kernel_message was sent to the webview.
		assert.deepStrictEqual(messaging.messagesToWebview, [{
			type: 'kernel_message',
			parent_id: message.parent_id,
			content: {
				type: 'clear_output',
				wait: message.wait,
			}
		} as ToWebviewMessage]);
	});

});
