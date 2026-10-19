import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { documentQueue } from '../queues/document.queue';
import { deadLetterQueue } from '../queues/dead-letter.queue';
import { maintenanceQueue } from '../queues/maintenance.queue';



const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');
createBullBoard({
    queues: [
        new BullMQAdapter(documentQueue),
        new BullMQAdapter(deadLetterQueue),
        new BullMQAdapter(maintenanceQueue),
    ],
    serverAdapter,
});

export { serverAdapter as bullBoardAdapter };