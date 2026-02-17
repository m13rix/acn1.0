import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
} from 'remotion';
import React from 'react';

export const Shot28: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 7.32s total
	// Original: 0-7s (Figures), 7-14s (Arrows) -> 50/50 split
	const splitFrame = Math.round(durationInFrames / 2);

	// Figures Animation (Pop in sequentially)
	const figures = [
		{label: 'Несовершеннолетний', x: '20%', y: '30%', delay: 0},
		{label: 'Обманутый супруг', x: '80%', y: '30%', delay: 10},
		{label: 'Прокурор', x: '50%', y: '80%', delay: 20},
	];

	// Arrows Animation (Fly to center)
	// Arrow progress starts after splitFrame
	const arrowProgress = interpolate(
		frame,
		[splitFrame, durationInFrames],
		[0, 1],
		{easing: Easing.out(Easing.cubic), extrapolateRight: 'clamp'}
	);

	return (
		<AbsoluteFill style={{backgroundColor: '#eef2f5'}}>
			{/* Main Background Image (Court Building or similar base) */}
			<AbsoluteFill>
				<Img
					src={staticFile('question_court.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'contain', // Infographic style, fit entire image
						opacity: 0.3,
					}}
				/>
			</AbsoluteFill>

			{/* Center Target (Court Icon or similar) */}
			<AbsoluteFill className="justify-center items-center">
				<div className="bg-blue-900 rounded-full w-24 h-24 flex justify-center items-center shadow-lg z-10">
					<span className="text-white text-4xl">⚖️</span>
				</div>
			</AbsoluteFill>

			{/* Figures and Texts */}
			{figures.map((fig, index) => {
				const opacity = interpolate(
					frame,
					[fig.delay, fig.delay + 15],
					[0, 1],
					{extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
				);
				
				const scale = interpolate(
					frame,
					[fig.delay, fig.delay + 15],
					[0, 1],
					{extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.back(1.5)}
				);

				// Arrow coordinates calculation (from fig position to center 50%, 50%)
				// We'll use SVG lines for arrows
				// Converting percentages to approximate values for visual line
				// Or using CSS transform for arrows
				
				// Assuming SVG overlay for arrows
				return (
					<React.Fragment key={index}>
						{/* Figure & Label */}
						<AbsoluteFill
							style={{
								left: fig.x,
								top: fig.y,
								width: 300,
								height: 150,
								transform: `translate(-50%, -50%) scale(${scale})`,
								opacity,
								justifyContent: 'center',
								alignItems: 'center',
								zIndex: 20,
							}}
						>
							<div className="flex flex-col items-center">
								<div className="text-6xl mb-2">👤</div>
								<div className="bg-white/90 px-4 py-2 rounded shadow border border-gray-300">
									<h3 
										className="text-gray-800 text-xl font-bold uppercase text-center"
										style={{fontFamily: 'Inter, sans-serif'}}
									>
										{fig.label}
									</h3>
								</div>
								<div className="text-4xl text-blue-600 font-bold mt-2">?</div>
							</div>
						</AbsoluteFill>
					</React.Fragment>
				);
			})}

			{/* Arrows Layer */}
			<svg className="absolute w-full h-full pointer-events-none" style={{zIndex: 15}}>
				{figures.map((fig, index) => {
					// Only show arrows after splitFrame
					if (frame < splitFrame) return null;

					// Determine line coordinates
					// Center is 50%, 50%
					const x1 = fig.x;
					const y1 = fig.y;
					const x2 = '50%';
					const y2 = '50%';

					return (
						<line
							key={`arrow-${index}`}
							x1={x1}
							y1={y1}
							x2={x2}
							y2={y2}
							stroke="#2563eb"
							strokeWidth="4"
							strokeDasharray="100%"
							strokeDashoffset={`${(1 - arrowProgress) * 100}%`} // Animate dash offset to "draw" the line
							markerEnd="url(#arrowhead)"
						/>
					);
				})}
				<defs>
					<marker
						id="arrowhead"
						markerWidth="10"
						markerHeight="7"
						refX="9"
						refY="3.5"
						orient="auto"
					>
						<polygon points="0 0, 10 3.5, 0 7" fill="#2563eb" />
					</marker>
				</defs>
			</svg>

			<Audio src={staticFile('shot28_voice.mp3')} />
		</AbsoluteFill>
	);
};
